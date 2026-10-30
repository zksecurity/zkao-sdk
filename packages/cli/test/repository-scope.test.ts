import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("login requests repository write scope only when explicitly requested", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      return Response.json({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.invalid/device",
        verificationUriComplete: "https://example.invalid/device?code=ABCD-EFGH",
        expiresIn: 60,
        interval: 5,
      });
    },
  });
  const home = await mkdtemp(join(tmpdir(), "zkao-scope-test-"));
  try {
    const cli = join(import.meta.dir, "../dist/index.js");
    for (const scopeArgs of [[], ["--scope", "read", "repositories:write"]]) {
      const process = Bun.spawn({
        cmd: ["bun", cli, "--base-url", `${server.url.origin}/api/v1`, "login", "--no-browser", "--no-wait", ...scopeArgs],
        env: { ...Bun.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    }
    const [defaultRequest, explicitRequest] = requests as { scopes: string[] }[];
    expect(defaultRequest?.scopes).not.toContain("repositories:write");
    expect(explicitRequest?.scopes).toEqual(["read", "repositories:write"]);
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
