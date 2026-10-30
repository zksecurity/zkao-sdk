import { expect, test } from "bun:test";
import { pollDeviceAuthorization, startDeviceAuthorization } from "../src/device-auth";

test("device authorization starts and polls the app endpoints", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json(requests.length === 1
      ? { deviceCode: "device", userCode: "CODE", verificationUri: "https://example.invalid/device", verificationUriComplete: "https://example.invalid/device?code=CODE", expiresIn: 900, interval: 5 }
      : { status: "approved", projectId: "p1", token: "token" });
  };
  const options = { baseUrl: "https://example.invalid/proxy/api/v1", fetch: fakeFetch };
  const start = await startDeviceAuthorization({ scopes: ["read", "repositories:write"] }, options);
  expect(start.userCode).toBe("CODE");
  const result = await pollDeviceAuthorization(start.deviceCode, options);
  expect(result.status).toBe("approved");
  expect(requests).toEqual([
    { url: "https://example.invalid/proxy/api/auth/device", body: { scopes: ["read", "repositories:write"] } },
    { url: "https://example.invalid/proxy/api/auth/device/token", body: { deviceCode: "device" } },
  ]);
});

test("polling maps a rate limit to slow_down", async () => {
  const result = await pollDeviceAuthorization("device", {
    baseUrl: "https://example.invalid/api/v1",
    fetch: async () => Response.json({ status: "slow_down" }, { status: 429 }),
  });
  expect(result).toEqual({ status: "slow_down" });
});
