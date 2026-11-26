import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ZkaoClient, type LaunchScanResult, type Scan, type ScanDetail } from "../packages/sdk/src/client";

let server: ReturnType<typeof Bun.serve>;
let client: ZkaoClient;
let payload: unknown;
const requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json(payload, { status: request.method === "POST" ? 202 : 200 });
    },
  });
  client = new ZkaoClient({
    token: "test-token",
    projectId: "project-id",
    baseUrl: `${server.url}api/v1`,
  });
});
afterAll(() => server.stop(true));

// Both new and older servers are supported; the SDK must not fabricate links.
const oldScan: Pick<Scan, "id" | "webUrl"> = { id: "scan-id" };
const oldDetail: Pick<ScanDetail, "id" | "webUrl"> = { id: "scan-id" };
const oldLaunch: Pick<LaunchScanResult, "scanId" | "webUrl"> = { scanId: "scan-id" };

describe("canonical scan web URLs", () => {
  for (const origin of ["https://zkao.io", "https://staging.zkao.io"]) {
    test(`preserves ${origin} URLs from list, detail, wait, and launch`, async () => {
      // Slugs deliberately differ from API IDs and the local test API origin.
      const webUrl = `${origin}/orgs/org-slug/projects/project-slug/repos/repo-slug/scans/scan-id`;
      const scan = { id: "scan-id", repositoryId: "repo-id", status: "COMPLETED", webUrl };
      payload = { items: [scan], page: 1, limit: 50, total: 1 };
      expect((await client.listScans()).items[0]?.webUrl).toBe(webUrl);
      payload = { scan: { ...scan, triage: { status: "complete", untriagedCount: 0, activeRunId: null, resume: null } } };
      expect((await client.getScan("scan-id")).webUrl).toBe(webUrl);
      expect((await client.waitForScan("scan-id")).webUrl).toBe(webUrl);
      payload = { scanId: "scan-id", queued: true, creditBudget: 2000, buildsOverview: false, webUrl };
      expect((await client.launchScan({ repositoryId: "repo-id", creditBudget: 2000 })).webUrl).toBe(webUrl);
    });
  }

  test("accepts older responses without a webUrl and never builds one", async () => {
    payload = { items: [oldScan], page: 1, limit: 50, total: 1 };
    expect((await client.listScans()).items[0]?.webUrl).toBeUndefined();
    payload = { scan: oldDetail };
    expect((await client.getScan("scan-id")).webUrl).toBeUndefined();
    payload = { ...oldLaunch, queued: true, creditBudget: 2000, buildsOverview: false };
    expect((await client.launchScan({ repositoryId: "repo-id", creditBudget: 2000 })).webUrl).toBeUndefined();
    expect(requests.every((path) => path.includes("/api/v1/projects/project-id/scans"))).toBe(true);
  });
});


test("CLI scan list, detail and launch print the server URL unchanged", async () => {
  const webUrl = "https://staging.zkao.io/orgs/org-slug/projects/project-slug/repos/repo-slug/scans/scan-id";
  const scan = { id: "scan-id", status: "COMPLETED", webUrl };
  for (const [args, reply] of [
    [["scans", "list"], { items: [scan], page: 1, limit: 50, total: 1 }],
    [["scans", "get", "scan-id"], { scan }],
    [["scans", "launch", "--repo", "repo-id", "--budget", "2000"], { scanId: "scan-id", queued: true, creditBudget: 2000, buildsOverview: false, webUrl }],
  ] as const) {
    payload = reply;
    const child = Bun.spawn(["node", fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url)), ...args], {
      env: { ...process.env, ZKAO_API_TOKEN: "test-token", ZKAO_PROJECT_ID: "project-id", ZKAO_URL: server.url.toString(), ZKAO_NO_UPDATE_CHECK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(status).toBe(0);
    const value = JSON.parse(stdout);
    expect(value.items ? value.items[0].webUrl : value.webUrl).toBe(webUrl);
  }
});
