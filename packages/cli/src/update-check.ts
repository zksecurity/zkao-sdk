import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./config";

/**
 * Tell the caller when a newer CLI has been published.
 *
 * The notice is the only channel that reaches an already-running agent: an
 * agent whose copy of the zkao skill predates a release cannot know it is
 * stale, but it does read this CLI's output, so a line here travels with every
 * command it runs.
 *
 * It must never slow a command down or change its result. The registry is
 * consulted at most once a day, after the command has already produced its
 * output, and the notice printed at startup comes from that cached answer. All
 * of it goes to stderr, so `zkao … | jq` keeps working.
 */

const CACHE_PATH = join(dirname(configPath()), "update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 1500;
const PACKAGE = "@zksecurity/zkao-cli";

type UpdateCache = {
  /** Epoch ms of the last successful registry read. */
  checkedAtMs: number;
  /** Latest version the registry reported. */
  latest: string;
};

function debug(message: string, err: unknown): void {
  if (process.env.ZKAO_DEBUG) {
    console.error(`zkao: ${message}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function disabled(): boolean {
  return Boolean(process.env.ZKAO_NO_UPDATE_CHECK);
}

function readCache(): UpdateCache | null {
  let raw: string;
  try {
    raw = readFileSync(CACHE_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      debug("could not read the update cache", err);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as UpdateCache;
    return typeof parsed.latest === "string" && typeof parsed.checkedAtMs === "number"
      ? parsed
      : null;
  } catch (err) {
    // Disposable state: a corrupt cache just means "check again".
    debug("ignoring an unparseable update cache", err);
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_PATH, `${JSON.stringify(cache)}\n`);
  } catch (err) {
    debug("could not write the update cache", err);
  }
}

/**
 * Compare two `x.y.z` versions. Anything carrying a prerelease or build suffix
 * is treated as not-newer, so a published `1.0.0-rc.1` never nags a stable
 * install.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!(a && b)) {
    return false;
  }
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) {
    return aMajor > bMajor;
  }
  if (aMinor !== bMinor) {
    return aMinor > bMinor;
  }
  return aPatch > bPatch;
}

/**
 * Print the notice if the last cached registry answer was newer than what is
 * running. Reads one small file and never touches the network, so it is safe to
 * call before the command runs.
 */
export function printUpdateNotice(currentVersion: string): void {
  if (disabled()) {
    return;
  }
  const cache = readCache();
  if (!(cache && isNewerVersion(cache.latest, currentVersion))) {
    return;
  }
  console.error(
    `zkao: version ${cache.latest} is available (running ${currentVersion}). ` +
      `Update with \`npm install -g ${PACKAGE}\`. ` +
      "If you are an agent working from a zkao skill file, update that too: it may describe fewer commands than the API now offers."
  );
}

/**
 * Refresh the cached registry answer, at most once per `CHECK_INTERVAL_MS`.
 * Call it after the command has printed its output: on a stale cache this waits
 * for the network (bounded by `REGISTRY_TIMEOUT_MS`), and a first run therefore
 * shows its notice on the NEXT invocation.
 */
export async function refreshUpdateCache(): Promise<void> {
  if (disabled()) {
    return;
  }
  const cache = readCache();
  if (cache && Date.now() - cache.checkedAtMs < CHECK_INTERVAL_MS) {
    return;
  }
  // A failed lookup still stamps the cache, so an offline or blocked machine
  // waits a day like any other rather than paying the timeout every command.
  const keepPrevious = () =>
    writeCache({ checkedAtMs: Date.now(), latest: cache?.latest ?? "" });
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) {
      debug("registry rejected the version lookup", new Error(`HTTP ${res.status}`));
      keepPrevious();
      return;
    }
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      debug("registry returned no version", new Error("missing `version`"));
      keepPrevious();
      return;
    }
    writeCache({ checkedAtMs: Date.now(), latest: body.version });
  } catch (err) {
    // Offline, blocked, or slow: an update check must never fail a command.
    debug("could not reach the npm registry", err);
    keepPrevious();
  }
}
