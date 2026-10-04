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

/** Credentials saved for one project, keyed by project id in the config file. */
export type SavedProject = {
  token: string;
  baseUrl?: string;
  name?: string;
  organization?: string;
};

/**
 * The file: the active project at the top level (the shape older CLIs wrote and
 * read), plus every project this machine holds a token for.
 */
type ConfigFile = ZkaoConfig & { projects?: Record<string, SavedProject> };

const CONFIG_PATH = join(homedir(), ".zkao", "config.json");

function readFile(): ConfigFile {
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
    return JSON.parse(raw) as ConfigFile;
  } catch (err) {
    // No `cause`: the parse detail is already in the message, and the CLI's
    // top-level handler prints the cause chain (it would print twice).
    throw new Error(
      `Could not parse ${CONFIG_PATH}: ${(err as Error).message}. ` +
        "Fix or delete the file, or overwrite it with `zkao config set`."
    );
  }
}

function readFileForWrite(): ConfigFile {
  let file: ConfigFile;
  try {
    file = readFile();
  } catch {
    // A corrupt file must not make `zkao config set` (the repair path) crash.
    console.error(`zkao: replacing unparseable config at ${CONFIG_PATH}`);
    return {};
  }
  // A file from an older CLI holds only the active project. Save it under its
  // id first, so switching away never drops its token.
  if (file.projectId && file.token && !file.projects?.[file.projectId]) {
    file.projects = {
      ...file.projects,
      [file.projectId]: stripUndefinedProject({
        token: file.token,
        baseUrl: file.baseUrl,
      }),
    };
  }
  return file;
}

function writeFile(file: ConfigFile): void {
  writeSecretFile(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

/** The top level mirrors the active project, so its base URL goes with it. */
function activate(file: ConfigFile, projectId: string, saved: SavedProject): void {
  file.projectId = projectId;
  file.token = saved.token;
  if (saved.baseUrl === undefined) {
    delete file.baseUrl;
  } else {
    file.baseUrl = saved.baseUrl;
  }
}

/**
 * `zkao config set`. A token with a project id is saved under that project. A
 * project id alone switches to that project's saved token when there is one.
 */
export function writeConfig(update: ZkaoConfig): ZkaoConfig {
  const file = readFileForWrite();
  const projectId = update.projectId ?? file.projectId;
  const saved = update.projectId ? file.projects?.[update.projectId] : undefined;
  if (update.token === undefined && update.projectId !== undefined && saved) {
    activate(file, update.projectId, {
      ...saved,
      baseUrl: update.baseUrl ?? saved.baseUrl,
    });
  } else {
    const switching =
      update.projectId !== undefined && update.projectId !== file.projectId;
    Object.assign(file, stripUndefined(update));
    if (switching && update.token === undefined) {
      // The old token belongs to another project; pairing them only yields 404s.
      delete file.token;
    }
  }
  if (projectId && file.token && file.projectId === projectId) {
    file.projects = {
      ...file.projects,
      [projectId]: {
        ...file.projects?.[projectId],
        token: file.token,
        baseUrl: file.baseUrl,
      },
    };
  }
  writeFile(file);
  return { token: file.token, projectId: file.projectId, baseUrl: file.baseUrl };
}

/** Save a project's credentials and make it the active project. */
export function saveProjectCredentials(
  projectId: string,
  saved: SavedProject
): void {
  const file = readFileForWrite();
  file.projects = { ...file.projects, [projectId]: stripUndefinedProject(saved) };
  activate(file, projectId, saved);
  writeFile(file);
}

/** Switch the active project to one with saved credentials. */
export function useProject(projectId: string): SavedProject {
  const file = readFileForWrite();
  const saved = file.projects?.[projectId];
  if (!saved) {
    throw new Error(
      `No saved credentials for project ${projectId}. Run \`zkao login --project ${projectId}\`.`
    );
  }
  activate(file, projectId, saved);
  writeFile(file);
  return saved;
}

/** Every project with saved credentials, plus which one is active. */
export function savedProjects(): {
  activeProjectId?: string;
  projects: Record<string, SavedProject>;
} {
  const file = readFile();
  return { activeProjectId: file.projectId, projects: file.projects ?? {} };
}

function stripUndefinedProject(saved: SavedProject): SavedProject {
  return Object.fromEntries(
    Object.entries(saved).filter(([, v]) => v !== undefined)
  ) as SavedProject;
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
  const projectId =
    flags.projectId ?? process.env.ZKAO_PROJECT_ID ?? file.projectId;
  const saved = projectId ? file.projects?.[projectId] : undefined;
  // The top-level token belongs to the active project only. Paired with any
  // other project id it would just get 404s.
  const activeMatches =
    file.projectId === undefined || file.projectId === projectId;
  return {
    token:
      flags.token ??
      process.env.ZKAO_API_TOKEN ??
      saved?.token ??
      (activeMatches ? file.token : undefined),
    projectId,
    baseUrl:
      flags.baseUrl ??
      resolveBaseUrlFromEnv() ??
      // The top-level base URL is the active project's; a saved project
      // carries its own (none means production).
      (saved ? saved.baseUrl : file.baseUrl),
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
  /** Code shown to the user; absent from files written by older CLIs. */
  userCode?: string;
  /** App origin to poll (`/api/auth/device/token`). */
  origin: string;
  /** Server-suggested seconds between polls. */
  interval: number;
  /** Epoch ms after which the device code is dead. */
  expiresAtMs: number;
  /** Base URL to persist on success, if non-default. */
  baseUrl?: string;
};

/**
 * Several logins can be pending at once (one per `zkao login --no-wait`),
 * keyed by device code. Older CLIs wrote a single `PendingLogin` object.
 */
type PendingFile = { logins: Record<string, PendingLogin> };

const PENDING_PATH = join(homedir(), ".zkao", "pending-login.json");

export function pendingLoginPath(): string {
  return PENDING_PATH;
}

function isPendingLogin(value: unknown): value is PendingLogin {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceCode === "string" &&
    typeof v.origin === "string" &&
    typeof v.interval === "number" &&
    typeof v.expiresAtMs === "number"
  );
}

/** Every pending login on disk, including expired ones. */
export function readPendingLogins(): PendingLogin[] {
  let raw: string;
  try {
    raw = readFileSync(PENDING_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Disposable state: treat a corrupt file as "no pending login" so a fresh
    // `zkao login --no-wait` simply overwrites it.
    console.error(
      `zkao: ignoring unparseable pending login at ${PENDING_PATH}`
    );
    return [];
  }
  if (isPendingLogin(parsed)) {
    return [parsed];
  }
  const logins = (parsed as Partial<PendingFile> | null)?.logins;
  return logins && typeof logins === "object"
    ? Object.values(logins).filter(isPendingLogin)
    : [];
}

function writePendingLogins(logins: PendingLogin[]): void {
  if (logins.length === 0) {
    try {
      unlinkSync(PENDING_PATH);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  const file: PendingFile = {
    logins: Object.fromEntries(logins.map((l) => [l.deviceCode, l])),
  };
  writeSecretFile(PENDING_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

/** Add a pending login, dropping any that have expired. */
export function addPendingLogin(pending: PendingLogin): void {
  const now = Date.now();
  writePendingLogins([
    ...readPendingLogins().filter(
      (l) => l.expiresAtMs > now && l.deviceCode !== pending.deviceCode
    ),
    pending,
  ]);
}

/** Drop pending logins by device code, plus any that have expired. */
export function removePendingLogins(deviceCodes: string[]): void {
  const now = Date.now();
  const drop = new Set(deviceCodes);
  writePendingLogins(
    readPendingLogins().filter(
      (l) => l.expiresAtMs > now && !drop.has(l.deviceCode)
    )
  );
}
