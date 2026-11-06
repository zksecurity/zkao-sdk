import { afterAll, beforeAll, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/dist/index.js");
let requests: { path: string; key: string | null; budget: number | null }[] = [];
let errorReply = false;
let polled = false;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() as { creditBudget: number } : null;
      requests.push({ path, key: request.headers.get("Idempotency-Key"), budget: body?.creditBudget ?? null });
      if (errorReply) {
        return Response.json({ error: { code: "idempotency_conflict", message: "Budget differs" } }, { status: 409 });
      }
      const run = {
        id: "triage-run",
        scanId: "scan",
        status: request.method === "POST" || !polled ? "QUEUED" : "COMPLETED",
        findingCount: 3,
        budgetExhausted: polled,
        createdAt: "2026-11-06T00:00:00.000Z",
        completedAt: polled ? "2026-11-06T00:01:00.000Z" : null,
      };
      polled = request.method === "GET";
      return Response.json(request.method === "POST" ? { run, replayed: false } : { run }, { headers: { "Retry-After": "0" } });
    },
  });
});

afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const child = Bun.spawn(["node", cliPath, ...args], {
    env: {
      ...process.env,
      ZKAO_API_TOKEN: "test-token",
      ZKAO_PROJECT_ID: "project",
      ZKAO_URL: server.url.toString(),
      ZKAO_NO_UPDATE_CHECK: "1",
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

test("resume command sends budget and caller's stable key, then waits on its own run", async () => {
  requests = [];
  errorReply = false;
  polled = false;
  const resumed = await cli("scans", "resume-triage", "scan", "--budget", "250", "--idempotency-key", "attempt-1");
  expect(resumed.status).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ run: { id: "triage-run", status: "QUEUED" }, replayed: false });
  expect(requests[0]).toEqual({ path: "/api/v1/projects/project/scans/scan/triage/resume", key: "attempt-1", budget: 250 });
  const waited = await cli("scans", "triage-wait", "scan", "triage-run", "--timeout", "5");
  expect(waited.status).toBe(0);
  expect(JSON.parse(waited.stdout)).toMatchObject({ id: "triage-run", status: "COMPLETED", budgetExhausted: true });
  expect(waited.stderr).toContain("QUEUED");
  expect(requests.slice(1).every((request) => request.path.endsWith("/triage/runs/triage-run"))).toBe(true);
});

test("resume refuses missing keys and malformed credit budgets before making requests", async () => {
  requests = [];
  const missing = await cli("scans", "resume-triage", "scan", "--budget", "250");
  const malformed = await cli("scans", "resume-triage", "scan", "--budget", "250junk", "--idempotency-key", "attempt-1");
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("--idempotency-key");
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain("Expected a positive integer");
  expect(requests).toHaveLength(0);
});

test("JSON error mode exposes API status and code while keeping stdout empty", async () => {
  errorReply = true;
  const failed = await cli("--json-errors", "scans", "resume-triage", "scan", "--budget", "250", "--idempotency-key", "attempt-1");
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe("");
  expect(JSON.parse(failed.stderr)).toEqual({ error: { status: 409, code: "idempotency_conflict", message: "Budget differs" } });
});
