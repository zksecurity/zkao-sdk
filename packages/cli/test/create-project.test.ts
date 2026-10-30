import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("project creation starts browser approval without selecting the old project", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json() as Record<string, unknown>);
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
  const home = await mkdtemp(join(tmpdir(), "zkao-project-test-"));
  try {
    const cli = join(import.meta.dir, "../dist/index.js");
    for (const scopeArgs of [[], ["--scope", "read"]]) {
      const child = Bun.spawn({
        cmd: ["bun", cli, "--base-url", `${server.url.origin}/api/v1`, "projects:create", "--no-browser", "--no-wait", ...scopeArgs],
        env: { ...Bun.env, HOME: home, ZKAO_PROJECT_ID: "oldproject" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("create a project");
      expect(stdout).toContain("zkao login --resume");
    }
    expect(requests[0]?.project).toBeUndefined();
    expect(requests[0]?.scopes).toContain("repositories:write");
    expect(requests[1]?.scopes).toEqual(["read"]);
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
