import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { DEFAULT_BASE_URL } from "@zksecurity/zkao-sdk";
import {
  clearPendingLogin,
  readPendingLogin,
  resolveConfig,
  writeConfig,
  writePendingLogin,
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
  | { status: "approved"; token: string; projectId: string };

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

function persistCredentials(
  poll: Extract<PollResponse, { status: "approved" }>,
  baseUrl?: string
): void {
  const saved = writeConfig({
    token: poll.token,
    projectId: poll.projectId,
    baseUrl,
  });
  clearPendingLogin();
  console.log("Authorized. Credentials saved.\n");
  console.log(`  project: ${saved.projectId}`);
}

export async function login(flags: LoginFlags): Promise<void> {
  const cfg = resolveConfig({
    token: flags.token,
    projectId: flags.project,
    baseUrl: flags.baseUrl,
  });
  const apiBase = cfg.baseUrl ?? DEFAULT_BASE_URL;
  const origin = appOrigin(apiBase);

  const start = await postJson<StartResponse>(`${origin}/api/auth/device`, {
    label: hostname(),
  });

  printInstructions(start);
  if (!flags.noBrowser) {
    openBrowser(start.verificationUriComplete);
  }

  // Persist immediately so a later `--resume` (or a Ctrl-C'd interactive run)
  // can finish without restarting the flow.
  writePendingLogin({
    deviceCode: start.deviceCode,
    origin,
    interval: Math.max(1, start.interval),
    expiresAtMs: Date.now() + start.expiresIn * 1000,
    baseUrl: cfg.baseUrl,
  });

  if (flags.wait === false) {
    console.log(
      "Once you approve in the browser, run `zkao login --resume` to finish.\n"
    );
    return;
  }

  await pollUntilDone({
    origin,
    deviceCode: start.deviceCode,
    intervalMs: Math.max(1, start.interval) * 1000,
    deadlineMs: Date.now() + start.expiresIn * 1000,
    baseUrl: cfg.baseUrl,
  });
}

export async function resumeLogin(flags: {
  timeout?: number;
}): Promise<void> {
  const pending = readPendingLogin();
  if (!pending) {
    throw new Error(
      "No pending login. Run `zkao login --no-wait` to start one first."
    );
  }
  if (Date.now() >= pending.expiresAtMs) {
    clearPendingLogin();
    throw new Error("The login request expired. Run `zkao login` again.");
  }

  // Bounded: `--timeout 0` (default) polls once and reports; a positive value
  // waits up to that many seconds. Either way the call returns promptly.
  const waitMs = (flags.timeout ?? 0) * 1000;
  await pollUntilDone({
    origin: pending.origin,
    deviceCode: pending.deviceCode,
    intervalMs: Math.max(1, pending.interval) * 1000,
    deadlineMs: Math.min(pending.expiresAtMs, Date.now() + waitMs),
    baseUrl: pending.baseUrl,
    reportStillPending: true,
  });
}

async function pollUntilDone(opts: {
  origin: string;
  deviceCode: string;
  intervalMs: number;
  deadlineMs: number;
  baseUrl?: string;
  /** When the deadline passes without resolution, return instead of throwing. */
  reportStillPending?: boolean;
}): Promise<void> {
  let intervalMs = opts.intervalMs;
  let polled = false;

  for (;;) {
    // Always poll at least once, even if the (bounded) deadline is already now.
    if (polled) {
      const remaining = opts.deadlineMs - Date.now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(intervalMs, remaining));
    }
    polled = true;

    const poll = await postJson<PollResponse>(
      `${opts.origin}/api/auth/device/token`,
      { deviceCode: opts.deviceCode }
    );

    switch (poll.status) {
      case "pending":
      case "slow_down":
        if (poll.status === "slow_down") {
          intervalMs += 2000;
        }
        break;
      case "denied":
        clearPendingLogin();
        throw new Error("Authorization was denied in the browser.");
      case "expired":
        clearPendingLogin();
        throw new Error("The login request expired. Run `zkao login` again.");
      case "approved":
        persistCredentials(poll, opts.baseUrl);
        return;
      default: {
        const _exhaustive: never = poll;
        throw new Error(
          `Unexpected device status: ${JSON.stringify(_exhaustive)}`
        );
      }
    }
  }

  if (opts.reportStillPending) {
    console.log(
      "Still waiting for approval. Approve in the browser, then run `zkao login --resume` again."
    );
    return;
  }
  throw new Error("The login request expired. Run `zkao login` again.");
}
