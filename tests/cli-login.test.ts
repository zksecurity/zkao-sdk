import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/cli/dist/index.js"
);
let polls = 0;
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "zkao-login-test-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/device") {
        return Response.json({
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          verificationUri: `${server.url}device`,
          verificationUriComplete: `${server.url}device?code=ABCD-EFGH`,
          expiresIn: 900,
          interval: 5,
        });
      }
      if (path === "/api/auth/device/token") {
        polls++;
        if (polls === 1) {
          // The token route answers its coarse per-IP limit with 429 +
          // slow_down; the CLI must treat that as pacing, not failure.
          return Response.json(
            { status: "slow_down" },
            { status: 429, headers: { "Retry-After": "5" } }
          );
        }
        const issued = {
          token: "zkao_proj_test_token",
          projectId: "project-1",
          projectName: "Project One",
          organizationName: "Org One",
        };
        return Response.json({
          status: "approved",
          ...issued,
          tokens: [issued],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const child = Bun.spawn(["node", cliPath, ...args], {
    env: {
      ...process.env,
      HOME: home,
      ZKAO_URL: server.url.toString(),
      ZKAO_NO_UPDATE_CHECK: "1",
      ZKAO_API_TOKEN: "",
      ZKAO_PROJECT_ID: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

test("device login survives a 429 slow_down poll and finishes on resume", async () => {
  const started = await cli("login", "--no-wait", "--no-browser");
  expect(started.status).toBe(0);
  expect(started.stdout).toContain("ABCD-EFGH");
  expect(
    existsSync(join(home, ".zkao", "pending-login.json"))
  ).toBe(true);

  const throttled = await cli("login", "--resume");
  expect(throttled.status).toBe(0);
  expect(throttled.stdout).toContain("Still waiting for approval");

  const finished = await cli("login", "--resume");
  expect(finished.status).toBe(0);
  expect(finished.stdout).toContain("Authorized for project");

  const config = JSON.parse(
    readFileSync(join(home, ".zkao", "config.json"), "utf8")
  ) as { token?: string; projectId?: string };
  expect(config.token).toBe("zkao_proj_test_token");
  expect(config.projectId).toBe("project-1");
  expect(existsSync(join(home, ".zkao", "pending-login.json"))).toBe(false);
});
