import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveBaseUrlFromEnv } from "@zksecurity/zkao-sdk";

/**
 * Resolved connection settings for the CLI. Resolution order (highest first):
 * explicit flags → environment variables → `~/.zkao/config.json`.
 */
export type ZkaoConfig = {
  token?: string;
  projectId?: string;
  baseUrl?: string;
};

const CONFIG_PATH = join(homedir(), ".zkao", "config.json");

function readFile(): ZkaoConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as ZkaoConfig;
  } catch (err) {
    // No `cause`: the parse detail is already in the message, and the CLI's
    // top-level handler prints the cause chain (it would print twice).
    throw new Error(
      `Could not parse ${CONFIG_PATH}: ${(err as Error).message}. ` +
        "Fix or delete the file, or overwrite it with `zkao config set`."
    );
  }
}

export function writeConfig(update: ZkaoConfig): ZkaoConfig {
  let existing: ZkaoConfig;
  try {
    existing = readFile();
  } catch {
    // A corrupt file must not make `zkao config set` (the repair path) crash.
    console.error(`zkao: replacing unparseable config at ${CONFIG_PATH}`);
    existing = {};
  }
  const merged = { ...existing, ...stripUndefined(update) };
  writeSecretFile(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/**
 * Write a file that holds a secret with owner-only permissions. writeFileSync's
 * `mode` only applies when the file is created, so chmod afterwards to tighten
 * a pre-existing file too.
 */
function writeSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function configPath(): string {
  return CONFIG_PATH;
}

function stripUndefined(obj: ZkaoConfig): ZkaoConfig {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as ZkaoConfig;
}

/**
 * Merge flags > env > file into a final config. The base URL comes from the
 * `--base-url` flag (verbatim) or `ZKAO_URL` (host/origin/full API URL,
 * normalized to `<origin>/api/v1`); see `resolveBaseUrlFromEnv` in
 * `@zksecurity/zkao-sdk`.
 */
export function resolveConfig(flags: ZkaoConfig): ZkaoConfig {
  const file = readFile();
  return {
    token: flags.token ?? process.env.ZKAO_API_TOKEN ?? file.token,
    projectId: flags.projectId ?? process.env.ZKAO_PROJECT_ID ?? file.projectId,
    baseUrl: flags.baseUrl ?? resolveBaseUrlFromEnv() ?? file.baseUrl,
  };
}

/**
 * State for a device login started with `zkao login --no-wait`, persisted so a
 * later `zkao login --resume` (e.g. from an agent on its own cadence) can finish
 * it. Holds the `deviceCode` (a short-lived bearer secret), so it is written
 * 0600 and removed once the login resolves.
 */
export type PendingLogin = {
  deviceCode: string;
  /** App origin to poll (`/api/auth/device/token`). */
  origin: string;
  /** Server-suggested seconds between polls. */
  interval: number;
  /** Epoch ms after which the device code is dead. */
  expiresAtMs: number;
  /** Base URL to persist on success, if non-default. */
  baseUrl?: string;
};

const PENDING_PATH = join(homedir(), ".zkao", "pending-login.json");

export function pendingLoginPath(): string {
  return PENDING_PATH;
}

export function writePendingLogin(pending: PendingLogin): void {
  writeSecretFile(PENDING_PATH, `${JSON.stringify(pending, null, 2)}\n`);
}

export function readPendingLogin(): PendingLogin | null {
  let raw: string;
  try {
    raw = readFileSync(PENDING_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as PendingLogin;
  } catch {
    // Disposable state: treat a corrupt file as "no pending login" so a fresh
    // `zkao login --no-wait` simply overwrites it.
    console.error(
      `zkao: ignoring unparseable pending login at ${PENDING_PATH}`
    );
    return null;
  }
}

export function clearPendingLogin(): void {
  try {
    unlinkSync(PENDING_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
