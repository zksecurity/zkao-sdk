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

/**
 * What a command runs with. `organizationId` is set when the token is a saved
 * organization token rather than a project's own.
 */
export type ResolvedConfig = ZkaoConfig & { organizationId?: string };

/** Credentials saved for one project, keyed by project id in the config file. */
export type SavedProject = {
  token: string;
  baseUrl?: string;
  name?: string;
  organization?: string;
};

/**
 * An organization token, keyed by organization id in the config file. It
 * reaches every project of that organization.
 */
export type SavedOrganization = {
  token: string;
  baseUrl?: string;
  name?: string;
  slug?: string;
};

/**
 * The file: the active project at the top level (the shape older CLIs wrote and
 * read), plus every project and organization this machine holds a token for.
 * The top-level `token` is only ever a project's own token. An active project
 * without one is reached through the active organization's token.
 */
type ConfigFile = ZkaoConfig & {
  projects?: Record<string, SavedProject>;
  organizations?: Record<string, SavedOrganization>;
  /** The active organization. */
  organizationId?: string;
};

type ActiveOrganization = { id: string; saved: SavedOrganization };

/** The active organization, or the only one saved. */
function activeOrganization(file: ConfigFile): ActiveOrganization | undefined {
  const all = file.organizations ?? {};
  const ids = Object.keys(all);
  const id =
    file.organizationId !== undefined && all[file.organizationId]
      ? file.organizationId
      : ids.length === 1
        ? ids[0]
        : undefined;
  const saved = id === undefined ? undefined : all[id];
  return id !== undefined && saved ? { id, saved } : undefined;
}

/** True when the active project has no token of its own. */
function activeProjectUsesOrganization(file: ConfigFile): boolean {
  return (
    file.projectId !== undefined &&
    file.token === undefined &&
    !file.projects?.[file.projectId]
  );
}

function setBaseUrl(file: ConfigFile, baseUrl: string | undefined): void {
  if (baseUrl === undefined) {
    delete file.baseUrl;
  } else {
    file.baseUrl = baseUrl;
  }
}

/**
 * Make an organization active. A project reached through another
 * organization's token stops being active: this one's token cannot reach it.
 */
function activateOrganization(file: ConfigFile, organizationId: string): void {
  const previous = activeOrganization(file);
  if (
    previous &&
    previous.id !== organizationId &&
    activeProjectUsesOrganization(file)
  ) {
    delete file.projectId;
    delete file.baseUrl;
  }
  file.organizationId = organizationId;
}

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
      [file.projectId]: stripUndefinedValues<SavedProject>({
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
  setBaseUrl(file, saved.baseUrl);
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
    Object.assign(file, stripUndefinedValues(update));
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
  file.projects = {
    ...file.projects,
    [projectId]: stripUndefinedValues(saved),
  };
  activate(file, projectId, saved);
  writeFile(file);
}

/**
 * Save an organization's token and make that organization active. Saved
 * project tokens stay, and so does an active project that has its own token.
 * Returns the project that is active afterwards, if any.
 */
export function saveOrganizationCredentials(
  organizationId: string,
  saved: SavedOrganization
): { activeProjectId?: string } {
  const file = readFileForWrite();
  file.organizations = {
    ...file.organizations,
    [organizationId]: stripUndefinedValues(saved),
  };
  activateOrganization(file, organizationId);
  writeFile(file);
  return { activeProjectId: file.projectId };
}

/**
 * Switch the active project. Its own saved token is used when there is one.
 * Otherwise the project is reached through the active organization's token.
 */
export function useProject(
  projectId: string
): { project: SavedProject } | { organization: SavedOrganization } {
  const file = readFileForWrite();
  const saved = file.projects?.[projectId];
  if (saved) {
    activate(file, projectId, saved);
    writeFile(file);
    return { project: saved };
  }
  const organization = activeOrganization(file);
  if (!organization) {
    throw new Error(
      `No saved credentials for project ${projectId}. Run \`zkao login --project ${projectId}\`, or \`zkao login --org\` for every project of its organization.`
    );
  }
  file.projectId = projectId;
  delete file.token;
  setBaseUrl(file, organization.saved.baseUrl);
  file.organizationId = organization.id;
  writeFile(file);
  return { organization: organization.saved };
}

/** Make a saved organization, named by id or slug, the active one. */
export function useOrganization(idOrSlug: string): {
  organizationId: string;
  saved: SavedOrganization;
} {
  const file = readFileForWrite();
  const found = Object.entries(file.organizations ?? {}).find(
    ([id, saved]) => id === idOrSlug || saved.slug === idOrSlug
  );
  if (!found) {
    throw new Error(
      `No saved credentials for organization ${idOrSlug}. Run \`zkao login --org ${idOrSlug}\`.`
    );
  }
  const [organizationId, saved] = found;
  activateOrganization(file, organizationId);
  writeFile(file);
  return { organizationId, saved };
}

/** Every project with saved credentials, plus which one is active. */
export function savedProjects(): {
  activeProjectId?: string;
  projects: Record<string, SavedProject>;
} {
  const file = readFile();
  return { activeProjectId: file.projectId, projects: file.projects ?? {} };
}

/** Every organization with a saved token, plus which one is active. */
export function savedOrganizations(): {
  activeOrganizationId?: string;
  organizations: Record<string, SavedOrganization>;
} {
  const file = readFile();
  return {
    activeOrganizationId: activeOrganization(file)?.id,
    organizations: file.organizations ?? {},
  };
}

function stripUndefinedValues<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as T;
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

/**
 * Merge flags > env > file into a final config. The base URL comes from the
 * `--base-url` flag (verbatim) or `ZKAO_URL` (host/origin/full API URL,
 * normalized to `<origin>/api/v1`); see `resolveBaseUrlFromEnv` in
 * `@zksecurity/zkao-sdk`.
 */
export function resolveConfig(flags: ZkaoConfig): ResolvedConfig {
  const file = readFile();
  const projectId =
    flags.projectId ?? process.env.ZKAO_PROJECT_ID ?? file.projectId;
  const saved = projectId ? file.projects?.[projectId] : undefined;
  // The top-level token belongs to the active project only. Paired with any
  // other project id it would just get 404s.
  const activeMatches =
    file.projectId === undefined || file.projectId === projectId;
  const projectToken =
    flags.token ??
    process.env.ZKAO_API_TOKEN ??
    saved?.token ??
    (activeMatches ? file.token : undefined);
  // A project's own token always wins for that project. The organization's
  // token only covers projects that have none.
  const organization =
    projectToken === undefined ? activeOrganization(file) : undefined;
  return {
    token: projectToken ?? organization?.saved.token,
    projectId,
    baseUrl:
      flags.baseUrl ??
      resolveBaseUrlFromEnv() ??
      // The top-level base URL is the active project's; a saved project or
      // organization carries its own (none means production).
      (saved
        ? saved.baseUrl
        : organization
          ? organization.saved.baseUrl
          : file.baseUrl),
    ...(organization ? { organizationId: organization.id } : {}),
  };
}

/**
 * Settings for the `/organizations/...` routes, which only an organization
 * token may call. An explicit token (flag or environment) wins, and its
 * organization is then unknown until the API is asked. Otherwise the saved
 * token of the active organization is used, whatever project is active.
 */
export function resolveOrganizationConfig(flags: ZkaoConfig): ResolvedConfig {
  const explicitToken = flags.token ?? process.env.ZKAO_API_TOKEN;
  if (explicitToken !== undefined) {
    return { token: explicitToken, baseUrl: resolveConfig(flags).baseUrl };
  }
  const organization = activeOrganization(readFile());
  if (!organization) {
    return {};
  }
  return {
    token: organization.saved.token,
    organizationId: organization.id,
    baseUrl:
      flags.baseUrl ?? resolveBaseUrlFromEnv() ?? organization.saved.baseUrl,
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
