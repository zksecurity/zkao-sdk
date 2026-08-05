import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Command } from "commander";
import {
  type LaunchScanRequest,
  type ResolutionReason,
  type ResolutionStatus,
  type Severity,
  ZkaoApiError,
  ZkaoClient,
} from "@zksecurity/zkao-sdk";
import { configPath, resolveConfig, writeConfig } from "./config";
import { login, resumeLogin } from "./login";
import { printUpdateNotice, refreshUpdateCache } from "./update-check";

// Resolved at runtime relative to the built dist/index.js, so the reported
// version can never drift from the published package.json.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command();

program
  .name("zkao")
  .description("Control a zkao project from the command line.")
  .version(version)
  .option("--token <token>", "project API token (or env ZKAO_API_TOKEN)")
  .option("--project <id>", "project id (or env ZKAO_PROJECT_ID)")
  .option("--base-url <url>", "API base URL, used verbatim (env: ZKAO_URL sets the environment)");

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function client(): ZkaoClient {
  const g = program.opts<{ token?: string; project?: string; baseUrl?: string }>();
  const cfg = resolveConfig({ token: g.token, projectId: g.project, baseUrl: g.baseUrl });
  if (!cfg.token) {
    fail("No API token. Pass --token, set ZKAO_API_TOKEN, or run `zkao config set --token <token>`.");
  }
  if (!cfg.projectId) {
    fail("No project id. Pass --project, set ZKAO_PROJECT_ID, or run `zkao config set --project <id>`.");
  }
  return new ZkaoClient({ token: cfg.token, projectId: cfg.projectId, baseUrl: cfg.baseUrl });
}

async function run(fn: (c: ZkaoClient) => Promise<unknown>): Promise<void> {
  try {
    out(await fn(client()));
  } catch (err) {
    if (err instanceof ZkaoApiError) {
      fail(`Error ${err.status} (${err.code}): ${err.message}`);
    }
    throw err;
  }
}

/** Read a `<file|->` argument: `-` means stdin, otherwise a file path. */
function readContentArg(source: string): string {
  try {
    return readFileSync(source === "-" ? 0 : source, "utf8");
  } catch (err) {
    fail(
      `Could not read ${source === "-" ? "stdin" : `"${source}"`}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];
const toInt = (value: string): number => {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) {
    fail(`Expected an integer, got "${value}"`);
  }
  return n;
};

// --- login ----------------------------------------------------------------

program
  .command("login")
  .description(
    "Authorize this CLI by approving it in your browser (device flow)"
  )
  .option("--no-browser", "print the URL instead of opening a browser")
  .option(
    "--no-wait",
    "start the flow, print the URL/code, and exit; finish with --resume"
  )
  .option("--resume", "poll a login previously started with --no-wait")
  .option(
    "--timeout <seconds>",
    "with --resume, wait up to this long for approval (default: poll once)",
    toInt
  )
  .action(
    async (opts: {
      browser?: boolean;
      wait?: boolean;
      resume?: boolean;
      timeout?: number;
    }) => {
      if (opts.resume) {
        await resumeLogin({ timeout: opts.timeout });
        return;
      }
      const g = program.opts<{
        token?: string;
        project?: string;
        baseUrl?: string;
      }>();
      await login({
        token: g.token,
        project: g.project,
        baseUrl: g.baseUrl,
        noBrowser: opts.browser === false,
        wait: opts.wait !== false,
      });
    }
  );

// --- config ---------------------------------------------------------------

const config = program.command("config").description("Manage stored credentials");
config
  .command("set")
  .description(`Persist settings to ${configPath()}`)
  .option("--token <token>", "project API token")
  .option("--project <id>", "project id")
  .option("--base-url <url>", "API base URL")
  .action((opts: { token?: string; project?: string; baseUrl?: string }) => {
    // The same flags exist at the program level, and commander resolves them
    // there even when they appear after `config set` — merge both scopes.
    const g = program.opts<{ token?: string; project?: string; baseUrl?: string }>();
    const update = {
      token: opts.token ?? g.token,
      projectId: opts.project ?? g.project,
      baseUrl: opts.baseUrl ?? g.baseUrl,
    };
    if (update.token === undefined && update.projectId === undefined && update.baseUrl === undefined) {
      fail("Nothing to save. Pass --token, --project, or --base-url.");
    }
    writeConfig(update);
    console.log(`Saved to ${configPath()}`);
  });
config
  .command("show")
  .description("Show the resolved settings (token masked)")
  .action(() => {
    const cfg = resolveConfig({});
    out({
      token: cfg.token ? `${cfg.token.slice(0, 14)}…` : null,
      projectId: cfg.projectId ?? null,
      baseUrl: cfg.baseUrl ?? "https://zkao.io/api/v1 (default)",
    });
  });

// --- repos ----------------------------------------------------------------

program
  .command("repos")
  .description("List repositories in the project")
  .action(() => run((c) => c.listRepositories()));

// --- guidance --------------------------------------------------------------

const guidance = program
  .command("guidance")
  .description("Read and update a repository's guidance");
guidance
  .command("get <repoId>")
  .description("Show a repository's configured guidance")
  .action((repoId: string) => run((c) => c.getRepositoryGuidance(repoId)));
guidance
  .command("set <repoId> <file|->")
  .description("Set a repository's guidance from a file (or - for stdin)")
  .option(
    "--force",
    "overwrite without the safety check that guidance did not change since last read"
  )
  .action((repoId: string, source: string, opts: { force?: boolean }) => {
    const content = readContentArg(source);
    return run(async (c) => {
      if (opts.force) {
        return c.setRepositoryGuidance(repoId, content);
      }
      // Read-then-compare-and-set by default so a concurrent edit (a teammate,
      // or an accepted suggestion) is reported as a conflict instead of being
      // silently clobbered. Pass --force to skip.
      const current = await c.getRepositoryGuidance(repoId);
      return c.setRepositoryGuidance(repoId, content, {
        expectedContent: current.content,
      });
    });
  });
guidance
  .command("clear <repoId>")
  .description("Remove a repository's guidance")
  .option("--force", "overwrite without the concurrent-change safety check")
  .action((repoId: string, opts: { force?: boolean }) =>
    run(async (c) => {
      if (opts.force) {
        return c.setRepositoryGuidance(repoId, null);
      }
      const current = await c.getRepositoryGuidance(repoId);
      return c.setRepositoryGuidance(repoId, null, {
        expectedContent: current.content,
      });
    })
  );

// --- scans ----------------------------------------------------------------

const scans = program.command("scans").description("Launch, list, and poll scans");
scans
  .command("list")
  .option("--page <n>", "page number", toInt)
  .option("--limit <n>", "page size (max 100)", toInt)
  .action((opts: { page?: number; limit?: number }) =>
    run((c) => c.listScans({ page: opts.page, limit: opts.limit }))
  );
scans
  .command("get <scanId>")
  .description("Get a scan's status and detail")
  .action((scanId: string) => run((c) => c.getScan(scanId)));
scans
  .command("wait <scanId>")
  .description("Poll a scan until it finishes (honors server backoff)")
  .option("--timeout <seconds>", "give up after this long", toInt)
  .action((scanId: string, opts: { timeout?: number }) => {
    const controller = new AbortController();
    const onSigint = () => controller.abort(new Error("Interrupted"));
    process.once("SIGINT", onSigint);
    return run((c) =>
      c
        .waitForScan(scanId, {
          timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
          signal: controller.signal,
          onPoll: (scan) =>
            console.error(`  scan ${scan.id}: ${scan.status}`),
        })
        .finally(() => process.removeListener("SIGINT", onSigint))
    );
  });
scans
  .command("launch")
  .description("Launch a scan")
  .requiredOption("--repo <id>", "repository id")
  .requiredOption("--budget <credits>", "max budget, in credits", toInt)
  .option("--preset <ref>", "scan preset ref (see `zkao presets`)")
  .option("--branch <name>", "branch to scan")
  .option("--commit <sha>", "specific commit to scan")
  .option("--message <text>", "commit message (metadata)")
  .option("--flow <id>", "optional-flow id to opt into (repeatable)", collect, [])
  .option(
    "--guidance <file|->",
    "per-scan guidance from a file (or - for stdin); replaces the repo's guidance for this scan"
  )
  .action(
    (opts: {
      repo: string;
      budget: number;
      preset?: string;
      branch?: string;
      commit?: string;
      message?: string;
      flow: string[];
      guidance?: string;
    }) => {
      const body: LaunchScanRequest = {
        repositoryId: opts.repo,
        creditBudget: opts.budget,
        presetRef: opts.preset,
        branch: opts.branch ?? null,
        commitHash: opts.commit ?? null,
        commitMessage: opts.message ?? null,
        optInFlowIds: opts.flow.length > 0 ? opts.flow : undefined,
        ...(opts.guidance !== undefined
          ? { guidance: readContentArg(opts.guidance) }
          : {}),
      };
      return run((c) => c.launchScan(body));
    }
  );
scans
  .command("cancel <scanId>")
  .description("Cancel a running or queued scan")
  .action((scanId: string) => run((c) => c.cancelScan(scanId)));
scans
  .command("publish <scanId>")
  .description("Publish a completed scan as a public artifact")
  .option("--password", "generate an access password")
  .action((scanId: string, opts: { password?: boolean }) =>
    run((c) => c.publishScan(scanId, { withPassword: opts.password }))
  );

// --- findings -------------------------------------------------------------

const findings = program.command("findings").description("Read and triage findings");
findings
  .command("list")
  .option("--scan <id>", "only findings for this scan")
  .option("--page <n>", "page number", toInt)
  .option("--limit <n>", "page size (max 100)", toInt)
  .action((opts: { scan?: string; page?: number; limit?: number }) =>
    run((c) => c.listFindings({ scanId: opts.scan, page: opts.page, limit: opts.limit }))
  );
findings
  .command("get <findingId>")
  .description("Get a finding's full detail")
  .action((findingId: string) => run((c) => c.getFinding(findingId)));
findings
  .command("comment <findingId> <text>")
  .description("Add a comment to a finding")
  .action((findingId: string, text: string) => run((c) => c.addFindingNote(findingId, text)));
findings
  .command("severity <findingId> <level>")
  .description("Override severity (CRITICAL|HIGH|MEDIUM|LOW|INFO, or 'none' to clear)")
  .action((findingId: string, level: string) => {
    const value = level.toLowerCase() === "none" ? null : (level.toUpperCase() as Severity);
    return run((c) => c.setFindingSeverity(findingId, value));
  });
findings
  .command("resolution <findingId> <status>")
  .description("Set resolution status (e.g. RESOLVED, WONT_FIX, FALSE_POSITIVE)")
  .option("--note <text>", "record the why as a comment in the same call")
  .option(
    "--reason <code>",
    "record the why as a catalog code instead (codes depend on the status; a wrong one is rejected with the valid list)"
  )
  .action((findingId: string, status: string, opts: { note?: string; reason?: string }) =>
    run((c) =>
      c.setFindingResolution(findingId, status.toUpperCase() as ResolutionStatus, {
        note: opts.note ? { content: opts.note } : undefined,
        reason: opts.reason as ResolutionReason | undefined,
      })
    )
  );
findings
  .command("publish <findingId>")
  .description("Publish a finding as a public artifact")
  .option("--note <noteId>", "note to pin as the published note")
  .option("--password", "generate an access password")
  .action((findingId: string, opts: { note?: string; password?: boolean }) =>
    run((c) => c.publishFinding(findingId, { noteId: opts.note, withPassword: opts.password }))
  );

// --- billing --------------------------------------------------------------

const billing = program
  .command("billing")
  .description("Read the project's credit balance and usage");
billing
  .command("balance")
  .description("Credit balance, what active scans hold, and what is available")
  .action(() => run((c) => c.getBillingBalance()));
billing
  .command("usage")
  .description("Credit ledger movements (defaults to the last 30 days)")
  .option("--from <date>", "ISO date or timestamp to start from")
  .option("--to <date>", "ISO date or timestamp to stop at")
  .option("--limit <n>", "max events to return", toInt)
  .action((opts: { from?: string; to?: string; limit?: number }) =>
    run((c) => c.getBillingUsage(opts))
  );
billing
  .command("summary")
  .description("Per-month credits spent and purchased, newest first")
  .option("--months <n>", "how many months to return", toInt)
  .action((opts: { months?: number }) =>
    run((c) => c.getBillingSummary({ months: opts.months }))
  );

// --- discovery ------------------------------------------------------------

program
  .command("presets")
  .description("List scan presets the project can launch")
  .action(() => run((c) => c.listScanPresets()));
program
  .command("flows")
  .description("List opt-in flows available at launch")
  .action(() => run((c) => c.listOptionalFlows()));

/**
 * Node's fetch rejects connection failures with a bare TypeError("fetch
 * failed") and buries the useful part (ECONNREFUSED, ENOTFOUND, host) in
 * `cause` — walk the chain so the user sees it.
 */
function errorMessage(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map(errorMessage).join("; ");
  }
  if (!(err instanceof Error)) {
    return String(err);
  }
  const message = err.message || String(err);
  return err.cause ? `${message}: ${errorMessage(err.cause)}` : message;
}

// From the cached registry answer only, so this costs one file read.
printUpdateNotice(version);

program
  .parseAsync()
  // After the command's own output, so a stale cache never delays it. `fail()`
  // exits the process, so this refreshes on the paths that succeed.
  .then(() => refreshUpdateCache())
  .catch((err) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
