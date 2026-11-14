import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/dist/index.js");
let requests: { method: string; path: string; body: unknown }[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? null : await request.json();
      requests.push({ method: request.method, path, body });
      if (path.endsWith("/continuous-testing")) {
        return Response.json({ repositoryId: "repo", branch: "main" });
      }
      if (path.endsWith("/prepare")) {
        return Response.json({ preparing: true });
      }
      if (path.endsWith("/answer")) {
        return Response.json({ questionId: "question", status: "ANSWERED" });
      }
      if (path.endsWith("/agent-questions")) {
        return Response.json({ questions: [] });
      }
      return Response.json({
        findingId: "finding",
        triageStatus: "CONFIRMED",
        previousTriageStatus: "FALSE_POSITIVE",
        noteId: "note",
      });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  requests = [];
});

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

test("triage overrides the verdict with a note and refuses other verdicts before asking", async () => {
  const done = await cli("findings", "triage", "finding", "confirmed", "--note", "Reproduced.");
  expect(done.status).toBe(0);
  expect(JSON.parse(done.stdout)).toMatchObject({ triageStatus: "CONFIRMED" });
  expect(requests).toEqual([
    {
      method: "PATCH",
      path: "/api/v1/projects/project/findings/finding/triage",
      body: { triageStatus: "CONFIRMED", note: "Reproduced." },
    },
  ]);
  const refused = await cli("findings", "triage", "finding", "untriaged");
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("confirmed or false-positive");
  expect(requests).toHaveLength(1);
});

test("questions are listed and answered with an option and a note", async () => {
  expect((await cli("questions", "list")).status).toBe(0);
  const answered = await cli("questions", "answer", "question", "--option", "No", "--note", "Only the parser.");
  expect(answered.status).toBe(0);
  expect(requests).toEqual([
    { method: "GET", path: "/api/v1/projects/project/agent-questions", body: null },
    {
      method: "POST",
      path: "/api/v1/projects/project/agent-questions/question/answer",
      body: { selectedOption: "No", note: "Only the parser." },
    },
  ]);
  const empty = await cli("questions", "answer", "question");
  expect(empty.status).toBe(1);
  expect(empty.stderr).toContain("--option");
  expect(requests).toHaveLength(2);
});

test("prepare plans the given branch, or the scheduled branch when none is given", async () => {
  expect((await cli("continuous", "prepare", "repo", "--branch", "release")).status).toBe(0);
  expect((await cli("continuous", "prepare", "repo")).status).toBe(0);
  expect(requests).toEqual([
    {
      method: "POST",
      path: "/api/v1/projects/project/repositories/repo/continuous-testing/prepare",
      body: { branch: "release" },
    },
    { method: "GET", path: "/api/v1/projects/project/repositories/repo/continuous-testing", body: null },
    {
      method: "POST",
      path: "/api/v1/projects/project/repositories/repo/continuous-testing/prepare",
      body: { branch: "main" },
    },
  ]);
});
