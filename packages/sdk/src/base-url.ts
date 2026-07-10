/**
 * Base-URL resolution for the SDK and CLI.
 *
 * One env var, `ZKAO_URL`, points at an environment. It accepts a bare host, an
 * origin, or a full API URL (e.g. `staging.zkao.io`, `http://localhost:3000`, or
 * `https://zkao.io/api/v1`) and is normalized to `<origin>[/path]/api/v1`. The
 * normalization is idempotent: a value already ending in `/api/vN` is left as-is.
 *
 * An explicit `baseUrl` passed to the client (or the CLI `--base-url` flag) wins
 * and is used verbatim, for the rare case that needs an exact, non-standard base.
 */

/** Production default; the `/api/v1` path is part of the base. */
export const DEFAULT_BASE_URL = "https://zkao.io/api/v1";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * Turn a host or origin (with or without scheme/path) into a full API base URL
 * ending in `/api/v1`. Idempotent: an input already ending in `/api/v<n>` is
 * left as-is. A bare host gets `https://` unless it is localhost (then `http://`).
 * A path component is preserved (and `/api/v1` appended after it).
 */
export function normalizeBaseUrl(value: string): string {
  const cleaned = unquote(value);
  if (cleaned.length === 0) {
    throw new Error("ZKAO_URL is empty");
  }

  let withScheme = cleaned;
  if (!/^https?:\/\//i.test(withScheme)) {
    const slash = withScheme.indexOf("/");
    let authority = slash === -1 ? withScheme : withScheme.slice(0, slash);
    const rest = slash === -1 ? "" : withScheme.slice(slash);
    let bareHost: string;
    if (authority.startsWith("[")) {
      // Bracketed IPv6, e.g. `[::1]:3000`.
      const end = authority.indexOf("]");
      bareHost = end === -1 ? authority : authority.slice(0, end + 1);
    } else if (authority.split(":").length > 2) {
      // Unbracketed IPv6, e.g. `::1` (a port would require brackets); the URL
      // parser needs it bracketed.
      bareHost = authority;
      authority = `[${authority}]`;
    } else {
      bareHost = authority.split(":")[0] ?? "";
    }
    withScheme = `${isLocalHost(bareHost) ? "http" : "https"}://${authority}${rest}`;
  }

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (err) {
    throw new Error(`Invalid ZKAO_URL: ${JSON.stringify(value)}`, {
      cause: err,
    });
  }

  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    // The bearer token would travel in clear text. Warn loudly but proceed:
    // forcing https here would break legitimate internal/proxied deployments.
    // biome-ignore lint/suspicious/noConsole: intentional operator-facing warning
    console.warn(
      `zkao: ZKAO_URL points at plaintext http://${url.hostname}; the API token will be sent unencrypted.`
    );
  }

  const path = url.pathname.replace(/\/+$/, "");
  const apiPath = /\/api\/v\d+$/.test(path) ? path : `${path}/api/v1`;
  return `${url.origin}${apiPath}`;
}

function readEnv(
  env: Record<string, string | undefined> | undefined
): Record<string, string | undefined> {
  if (env) {
    return env;
  }
  // Read process.env without depending on @types/node so the SDK stays
  // browser-safe (where `process` is simply absent).
  const proc = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return proc?.env ?? {};
}

/**
 * Resolve a base URL from `ZKAO_URL`, or `undefined` if it is not set. The value
 * (host, origin, or full API URL) is normalized to `<origin>[/path]/api/v1`.
 */
export function resolveBaseUrlFromEnv(
  env?: Record<string, string | undefined>
): string | undefined {
  const source = readEnv(env);

  const origin = source.ZKAO_URL ? unquote(source.ZKAO_URL) : "";
  if (origin.length > 0) {
    return normalizeBaseUrl(origin);
  }

  return undefined;
}
