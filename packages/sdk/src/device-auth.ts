import { DEFAULT_BASE_URL, resolveBaseUrlFromEnv } from "./base-url";

export type DeviceAuthorizationOptions = {
  /** API base URL; the device endpoints are hosted at the app origin. */
  baseUrl?: string;
  /** Optional custom fetch for tests or proxies. */
  fetch?: typeof fetch;
};

export type DeviceAuthorizationRequest = {
  label?: string;
  scopes?: string[];
  project?: string;
};

export type DeviceAuthorizationStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceAuthorizationToken = {
  token: string;
  projectId: string;
  projectName?: string;
  organizationName?: string;
};

export type DeviceAuthorizationPoll =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | ({ status: "approved"; tokens?: DeviceAuthorizationToken[] } & DeviceAuthorizationToken);

function deviceUrl(options: DeviceAuthorizationOptions, path: string): string {
  const base = options.baseUrl ?? resolveBaseUrlFromEnv() ?? DEFAULT_BASE_URL;
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/api\/v\d+$/, "");
  return `${url.origin}${prefix}/api/auth/device${path}`;
}

async function requestDevice<T>(
  path: string,
  body: unknown,
  options: DeviceAuthorizationOptions,
): Promise<T> {
  const response = await (options.fetch ?? fetch)(deviceUrl(options, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (path === "/token" && response.status === 429) {
    return { status: "slow_down" } as T;
  }
  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      message = data.error?.message ?? message;
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(`Device authorization failed (${response.status}): ${message}`);
  }
  return (await response.json()) as T;
}

/** Begin browser approval. An organization admin can create a project there. */
export function startDeviceAuthorization(
  request: DeviceAuthorizationRequest = {},
  options: DeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationStart> {
  return requestDevice("", request, options);
}

/** Poll once after the server-provided interval. The approved token is returned once. */
export function pollDeviceAuthorization(
  deviceCode: string,
  options: DeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationPoll> {
  return requestDevice("/token", { deviceCode }, options);
}
