import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { DEFAULT_BASE_URL } from "@zksecurity/zkao-sdk";
import {
  addPendingLogin,
  type PendingLogin,
  readPendingLogins,
  removePendingLogins,
  resolveConfig,
  saveProjectCredentials,
} from "./config";

/**
 * `zkao login` — OAuth-style device-authorization flow (RFC 8628 shape).
 *
 * The CLI has no credentials yet, so it cannot use the bearer-token API. It
 * calls the unauthenticated device endpoints on the app origin (`/api/auth/...`,
 * NOT `/api/v1`), shows the user a code + URL to approve in their browser, then
 * polls until a project API token is minted and handed back exactly once.
 *
 * Two shapes:
 *   - Interactive (`zkao login`): start, then block-poll until approved.
 *   - Split, for agents/non-interactive callers:
 *       `zkao login --no-wait`  starts the flow, prints the URL/code, and exits.
 *       `zkao login --resume`   polls the pending request (bounded) and exits.
 *     This avoids a single multi-minute blocking call that an agent's command
 *     timeout would kill before the human approves.
 */

type StartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

type PollResponse =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      token: string;
      projectId: string;
      /** Absent from servers that predate them. */
      projectName?: string;
      organizationName?: string;
    };

export type LoginFlags = {
  token?: string;
  project?: string;
  baseUrl?: string;
  noBrowser?: boolean;
  /** false = start and exit (`--no-wait`); true (default) = block until done. */
  wait?: boolean;
};

/**
 * The app base the device endpoints live on: the API base URL minus its
 * `/api/vN` suffix. A path prefix is kept (normalizeBaseUrl supports
 * `https://host/zkao/api/v1` for proxied deployments, whose auth endpoints
 * live at `https://host/zkao/api/auth/...`).
 */
function appOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/api\/v\d+$/, "");
  return `${url.origin}${prefix}`;
}

/** Best-effort browser launch; never throws (headless/agent environments). */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // ignore: the URL is already printed for manual opening
    });
    child.unref();
  } catch {
    // ignore: the URL is already printed for manual opening
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { error?: { message?: string } };
      detail = data.error?.message ?? detail;
    } catch {
      // keep statusText
    }
    throw new Error(`Device authorization failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

function printInstructions(start: StartResponse): void {
  // Print the pre-filled URL (code in the query) so the user can open it
  // directly. Still show the code on its own so they can confirm the page shows
  // the same one before approving.
  console.log("\nTo authorize this CLI, open this URL and approve:\n");
  console.log(`  ${start.verificationUriComplete}`);
  console.log(
    `\nConfirm the page shows this code:  ${start.userCode}\n` +
      "Approve only if you started this login.\n"
  );
}

export function describeProject(
  projectId: string,
  names: { name?: string; organization?: string }
): string {
  if (!names.name) {
    return projectId;
  }
  const org = names.organization ? ` of organization "${names.organization}"` : "";
  return `"${names.name}"${org} (${projectId})`;
}

function persistCredentials(
  poll: Extract<PollResponse, { status: "approved" }>,
  baseUrl?: string
): void {
  saveProjectCredentials(poll.projectId, {
    token: poll.token,
    baseUrl,
    name: poll.projectName,
    organization: poll.organizationName,
  });
  console.log(
    `Authorized for project ${describeProject(poll.projectId, {
      name: poll.projectName,
      organization: poll.organizationName,
    })}. It is now the active project.`
  );
  console.log(
    "Credentials for other projects are kept. `zkao config show` lists them; `zkao config use <projectId>` switches."
  );
}

export async function login(flags: LoginFlags): Promise<void> {
  const cfg = resolveConfig({
    token: flags.token,
    projectId: flags.project,
    baseUrl: flags.baseUrl,
  });
  const apiBase = cfg.baseUrl ?? DEFAULT_BASE_URL;
  const origin = appOrigin(apiBase);

  // Preselects the project on the approval page. Only an explicit choice:
  // the saved active project is likely the one the user wants to move off.
  const project = flags.project ?? process.env.ZKAO_PROJECT_ID;
  const start = await postJson<StartResponse>(`${origin}/api/auth/device`, {
    label: hostname(),
    ...(project ? { project } : {}),
  });

  printInstructions(start);
  if (!flags.noBrowser) {
    openBrowser(start.verificationUriComplete);
  }

  // Persist immediately so a later `--resume` (or a Ctrl-C'd interactive run)
  // can finish without restarting the flow.
  const pending: PendingLogin = {
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    origin,
    interval: Math.max(1, start.interval),
    expiresAtMs: Date.now() + start.expiresIn * 1000,
    baseUrl: cfg.baseUrl,
  };
  addPendingLogin(pending);

  if (flags.wait === false) {
    console.log(
      "Once you approve in the browser, run `zkao login --resume` to finish.\n"
    );
    return;
  }

  await pollUntilDone([pending], pending.expiresAtMs);
}

export async function resumeLogin(flags: {
  timeout?: number;
}): Promise<void> {
  const all = readPendingLogins();
  const now = Date.now();
  const live = all.filter((l) => l.expiresAtMs > now);
  if (live.length < all.length) {
    removePendingLogins([]);
  }
  if (live.length === 0) {
    throw new Error(
      all.length > 0
        ? "The login request expired. Run `zkao login` again."
        : "No pending login. Run `zkao login --no-wait` to start one first."
    );
  }

  // Bounded: `--timeout 0` (default) polls once and reports; a positive value
  // waits up to that many seconds. Either way the call returns promptly.
  const waitMs = (flags.timeout ?? 0) * 1000;
  const lastExpiry = Math.max(...live.map((l) => l.expiresAtMs));
  await pollUntilDone(live, Math.min(lastExpiry, Date.now() + waitMs), true);
}

function label(pending: PendingLogin): string {
  return pending.userCode ? `code ${pending.userCode}` : "an earlier login";
}

/**
 * Poll every pending login each round until one is approved. Denied and
 * expired logins are dropped. With several pending, the others are reported
 * and kept for a later `--resume`.
 */
async function pollUntilDone(
  logins: PendingLogin[],
  deadlineMs: number,
  /** When the deadline passes without resolution, return instead of throwing. */
  reportStillPending = false
): Promise<void> {
  let open = [...logins];
  let intervalMs = Math.min(...open.map((l) => Math.max(1, l.interval))) * 1000;
  let lastFailure = "The login request expired. Run `zkao login` again.";
  let polled = false;

  while (open.length > 0) {
    // Always poll at least once, even if the (bounded) deadline is already now.
    if (polled) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(intervalMs, remaining));
    }
    polled = true;

    const resolved: string[] = [];
    const dropped: string[] = [];
    for (const pending of open) {
      if (Date.now() >= pending.expiresAtMs) {
        resolved.push(pending.deviceCode);
        dropped.push(`${label(pending)} expired`);
        lastFailure = "The login request expired. Run `zkao login` again.";
        continue;
      }
      const poll = await postJson<PollResponse>(
        `${pending.origin}/api/auth/device/token`,
        { deviceCode: pending.deviceCode }
      );
      switch (poll.status) {
        case "pending":
          break;
        case "slow_down":
          intervalMs += 2000;
          break;
        case "denied":
          resolved.push(pending.deviceCode);
          dropped.push(`${label(pending)} was denied`);
          lastFailure = "Authorization was denied in the browser.";
          break;
        case "expired":
          resolved.push(pending.deviceCode);
          dropped.push(`${label(pending)} expired`);
          lastFailure = "The login request expired. Run `zkao login` again.";
          break;
        case "approved": {
          removePendingLogins([...resolved, pending.deviceCode]);
          persistCredentials(poll, pending.baseUrl);
          const rest = open.filter(
            (l) => l !== pending && !resolved.includes(l.deviceCode)
          );
          if (rest.length > 0) {
            console.log(
              `Still pending: ${rest.map(label).join(", ")}. Run \`zkao login --resume\` again to finish ${rest.length > 1 ? "them" : "it"}.`
            );
          }
          return;
        }
        default: {
          const _exhaustive: never = poll;
          throw new Error(
            `Unexpected device status: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    }
    if (resolved.length > 0) {
      removePendingLogins(resolved);
      open = open.filter((l) => !resolved.includes(l.deviceCode));
      if (open.length > 0) {
        console.error(`zkao: dropped pending login: ${dropped.join(", ")}.`);
      }
    }
  }

  if (open.length === 0) {
    throw new Error(lastFailure);
  }
  if (reportStillPending) {
    console.log(
      open.length > 1
        ? `Still waiting for approval of ${open.length} logins (${open.map(label).join(", ")}). Approve in the browser, then run \`zkao login --resume\` again.`
        : "Still waiting for approval. Approve in the browser, then run `zkao login --resume` again."
    );
    return;
  }
  throw new Error("The login request expired. Run `zkao login` again.");
}
