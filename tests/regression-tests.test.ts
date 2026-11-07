import { afterAll, beforeAll, expect, test } from "bun:test";
import { ZkaoApiError, ZkaoClient } from "../packages/sdk/src/client";

type Request = { method: string; path: string; key: string | null; body: unknown };
const requests: Request[] = [];
let replies: Array<{ status?: number; body: unknown }> = [];
let server: ReturnType<typeof Bun.serve>;
let client: ZkaoClient;

const run = {
  id: "regression-run", findingId: "finding", status: "QUEUED",
  creditBudget: 100, targetBranch: "main", targetCommit: "b".repeat(40),
  auditedCommit: "a".repeat(40), summary: null, pullRequestUrl: null,
  audited: null, target: null, createdAt: "2026-11-06T00:00:00.000Z", completedAt: null,
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        method: request.method, path: new URL(request.url).pathname,
        key: request.headers.get("Idempotency-Key"), body: text ? JSON.parse(text) : null,
      });
      const reply = replies.shift();
      return reply
        ? Response.json(reply.body, { status: reply.status ?? 200 })
        : Response.json({ error: { code: "unexpected_request", message: "Unexpected request" } }, { status: 500 });
    },
  });
  client = new ZkaoClient({ token: "test-token", projectId: "project", baseUrl: `${server.url}api/v1` });
});
afterAll(() => server.stop(true));

test("preserves budget and request key when a paid attempt is replayed", async () => {
  requests.length = 0;
  replies = [
    { status: 202, body: { run, replayed: false } },
    { status: 202, body: { run, replayed: true } },
  ];
  const body = { creditBudget: 100, targetBranch: "main" };
  const first = await client.createRegressionTest("finding", body, { idempotencyKey: "same-request" });
  const replay = await client.createRegressionTest("finding", body, { idempotencyKey: "same-request" });
  expect(first.run.id).toBe(replay.run.id);
  expect(replay.replayed).toBe(true);
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({
    method: "POST", path: "/api/v1/projects/project/findings/finding/regression-tests",
    key: "same-request", body,
  })));
});

test("reads readiness, history and one run without launching work", async () => {
  requests.length = 0;
  const readiness = { status: "pending", settingsUrl: "https://github.com/settings/installations/123", defaultBranch: "main", message: "Approve write permissions" };
  replies = [{ body: readiness }, { body: { runs: [run] } }, { body: run }];
  expect(await client.getRegressionTestReadiness("finding")).toEqual(readiness);
  expect(await client.listRegressionTests("finding")).toEqual([run]);
  expect(await client.getRegressionTest("finding", "regression-run")).toEqual(run);
  expect(requests.map(request => [request.method, request.path])).toEqual([
    ["GET", "/api/v1/projects/project/findings/finding/regression-tests/readiness"],
    ["GET", "/api/v1/projects/project/findings/finding/regression-tests"],
    ["GET", "/api/v1/projects/project/findings/finding/regression-tests/regression-run"],
  ]);
});

test("retries only the saved publication without sending a generation budget", async () => {
  requests.length = 0;
  replies = [{ status: 202, body: { ...run, status: "READY" } }];
  expect((await client.retryRegressionTestPublication("finding", "regression-run")).status).toBe("READY");
  expect(requests).toEqual([{
    method: "POST", path: "/api/v1/projects/project/findings/finding/regression-tests/regression-run/retry-publication",
    key: null, body: null,
  }]);
});

test("preserves the API refusal when write authorization is missing", async () => {
  replies = [{ status: 403, body: { error: { code: "forbidden", message: "GitHub write access is required" } } }];
  try {
    await client.createRegressionTest("finding", { creditBudget: 100 }, { idempotencyKey: "request" });
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ZkaoApiError);
    expect(error).toMatchObject({ status: 403, code: "forbidden", message: "GitHub write access is required" });
  }
});
