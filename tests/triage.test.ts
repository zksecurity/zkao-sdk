import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ZkaoApiError, ZkaoClient } from "../packages/sdk/src/client";

type ApiRequest = { method: string; path: string; key: string | null; body: unknown };
const requests: ApiRequest[] = [];
let replies: { status?: number; body: unknown; retryAfter?: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
let client: ZkaoClient;

const run = (status: string, budgetExhausted = false) => ({
  id: "triage-run",
  scanId: "scan",
  status,
  budgetExhausted,
  findingCount: 3,
  createdAt: "2026-11-06T00:00:00.000Z",
  completedAt: ["COMPLETED", "FAILED", "CANCELLED"].includes(status)
    ? "2026-11-06T00:01:00.000Z"
    : null,
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        key: request.headers.get("Idempotency-Key"),
        body: request.method === "POST" ? await request.json() : null,
      });
      const reply = replies.shift();
      if (!reply) {
        return Response.json({ error: { code: "unexpected_request", message: "Unexpected request" } }, { status: 500 });
      }
      return Response.json(reply.body, {
        status: reply.status ?? 200,
        headers: reply.retryAfter === undefined ? {} : { "Retry-After": reply.retryAfter },
      });
    },
  });
  client = new ZkaoClient({
    token: "test-token",
    projectId: "project",
    baseUrl: `${server.url}api/v1`,
  });
});

afterAll(() => server.stop(true));

describe("triage resumption", () => {
  test("preserves the explicit budget and idempotency key across a replay", async () => {
    requests.length = 0;
    replies = [
      { body: { run: run("QUEUED"), replayed: false } },
      { body: { run: run("COMPLETED", true), replayed: true } },
    ];
    const first = await client.resumeTriage("scan", { creditBudget: 250 }, { idempotencyKey: "same-request" });
    const replay = await client.resumeTriage("scan", { creditBudget: 250 }, { idempotencyKey: "same-request" });
    expect(first.run.id).toBe(replay.run.id);
    expect(replay.replayed).toBe(true);
    expect(replay.run.budgetExhausted).toBe(true);
    expect(requests).toEqual([
      { method: "POST", path: "/api/v1/projects/project/scans/scan/triage/resume", key: "same-request", body: { creditBudget: 250 } },
      { method: "POST", path: "/api/v1/projects/project/scans/scan/triage/resume", key: "same-request", body: { creditBudget: 250 } },
    ]);
  });

  test("polls the requested triage run through throttling and active states", async () => {
    requests.length = 0;
    replies = [
      { status: 429, body: { error: { code: "rate_limited", message: "Slow down" } }, retryAfter: "0" },
      { body: { run: run("QUEUED") }, retryAfter: "0" },
      { body: { run: run("RUNNING") }, retryAfter: "0" },
      { body: { run: run("COMPLETED", true) } },
    ];
    const statuses: string[] = [];
    const result = await client.waitForTriageRun("scan", "triage-run", {
      intervalMs: 60_000,
      timeoutMs: 1000,
      onPoll: (current) => statuses.push(current.status),
    });
    expect(result.status).toBe("COMPLETED");
    expect(result.budgetExhausted).toBe(true);
    expect(statuses).toEqual(["QUEUED", "RUNNING"]);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.path.endsWith("/triage/runs/triage-run"))).toBe(true);
  });

  test("returns failed and cancelled runs as terminal results", async () => {
    for (const status of ["FAILED", "CANCELLED"]) {
      replies = [{ body: { run: run(status) } }];
      expect((await client.waitForTriageRun("scan", "triage-run")).status).toBe(status);
    }
  });

  test("honors a server delay that exceeds the remaining wait budget", async () => {
    replies = [{ body: { run: run("RUNNING") }, retryAfter: "3600" }];
    await expect(client.waitForTriageRun("scan", "triage-run", { timeoutMs: 100 })).rejects.toThrow("Timed out waiting for triage run triage-run");
  });

  test("abort before polling makes no request", async () => {
    requests.length = 0;
    const controller = new AbortController();
    controller.abort(new Error("User stopped waiting"));
    await expect(client.waitForTriageRun("scan", "triage-run", { signal: controller.signal })).rejects.toThrow("User stopped waiting");
    expect(requests).toHaveLength(0);
  });

  test("preserves API error status and code", async () => {
    replies = [{ status: 409, body: { error: { code: "idempotency_conflict", message: "Budget differs" } } }];
    try {
      await client.resumeTriage("scan", { creditBudget: 500 }, { idempotencyKey: "same-request" });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ZkaoApiError);
      expect(error).toMatchObject({ status: 409, code: "idempotency_conflict", message: "Budget differs" });
    }
  });
});
