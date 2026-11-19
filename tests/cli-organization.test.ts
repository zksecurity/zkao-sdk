import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/cli/dist/index.js"
);

const ORG_TOKEN = "zkao_org_key1_orgsecret";
const PROJECT_TOKEN = "zkao_proj_key1_projectsecret";
const organization = { id: "org-1", slug: "acme", name: "Acme" };
const project = {
  id: "project-2",
  slug: "widgets",
  name: "widgets",
  description: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  repositoryCount: 0,
};
const repository = { id: "repo-1", owner: "acme", name: "widget", readiness: "analyzing" };

type Recorded = { method: string; path: string; token: string | null; body: unknown };
let requests: Recorded[] = [];
/** Device codes whose login asked for an organization. */
const organizationLogins = new Set<string>();
let logins = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? null : await request.json();
      const token =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      requests.push({ method: request.method, path, token, body });

      if (path === "/api/auth/device") {
        const deviceCode = `device-${++logins}`;
        if ((body as { organization?: unknown }).organization !== undefined) {
          organizationLogins.add(deviceCode);
        }
        return Response.json({
          deviceCode,
          userCode: "ABCD-EFGH",
          verificationUri: `${server.url}device`,
          verificationUriComplete: `${server.url}device?code=ABCD-EFGH`,
          expiresIn: 900,
          interval: 5,
        });
      }
      if (path === "/api/auth/device/token") {
        const { deviceCode } = body as { deviceCode: string };
        if (organizationLogins.has(deviceCode)) {
          return Response.json({
            status: "approved",
            kind: "organization",
            token: ORG_TOKEN,
            organization,
          });
        }
        const issued = {
          token: PROJECT_TOKEN,
          projectId: "project-1",
          projectName: "Project One",
          organizationName: "Acme",
        };
        return Response.json({ status: "approved", ...issued, tokens: [issued] });
      }

      const api = path.replace(/^\/api\/v1/, "");
      if (api === "/token") {
        const isOrganization = token === ORG_TOKEN;
        return Response.json({
          id: "token-1",
          kind: isOrganization ? "organization" : "project",
          name: "laptop",
          scopes: ["read"],
          repositoryIds: [],
          expiresAt: null,
          spendLimitCredits: null,
          organization,
          project: isOrganization
            ? null
            : { id: "project-1", slug: "one", name: "Project One", organization },
        });
      }
      if (api === "/organizations/org-1/projects") {
        return request.method === "POST"
          ? Response.json({ project }, { status: 201 })
          : Response.json({ items: [project], page: 1, limit: 20, total: 1 });
      }
      if (api === "/organizations/org-1/projects/project-2") {
        return Response.json({ project: { ...project, name: "gadgets" } });
      }
      if (api === "/organizations/org-1/projects/project-2/repositories") {
        return Response.json({ repository }, { status: 201 });
      }
      if (api === "/organizations/org-1/repositories/repo-1/move") {
        return Response.json({ repository, projectId: "project-2" });
      }
      if (/^\/projects\/[^/]+\/repositories$/.test(api)) {
        return Response.json({ repositories: [] });
      }
      return Response.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 }
      );
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  requests = [];
});

function newHome(): string {
  return mkdtempSync(join(tmpdir(), "zkao-org-test-"));
}

async function cli(
  home: string,
  args: string[],
  extraEnv: Record<string, string> = {}
) {
  // An empty ZKAO_API_TOKEN would still shadow the saved credentials.
  const { ZKAO_API_TOKEN: _token, ZKAO_PROJECT_ID: _project, ...inherited } =
    process.env;
  const child = Bun.spawn(["node", cliPath, ...args], {
    env: {
      ...inherited,
      HOME: home,
      ZKAO_URL: server.url.toString(),
      ZKAO_NO_UPDATE_CHECK: "1",
      ...extraEnv,
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

function readConfig(home: string) {
  return JSON.parse(
    readFileSync(join(home, ".zkao", "config.json"), "utf8")
  ) as {
    token?: string;
    projectId?: string;
    organizationId?: string;
    projects?: Record<string, { token: string }>;
    organizations?: Record<string, { token: string; name?: string; slug?: string }>;
  };
}

async function loginToOrganization(home: string) {
  const started = await cli(home, ["login", "--no-wait", "--no-browser", "--org", "acme"]);
  expect(started.status).toBe(0);
  const finished = await cli(home, ["login", "--resume"]);
  expect(finished.status).toBe(0);
  return finished;
}

/** The API calls only, without the device endpoints. */
function apiRequests() {
  return requests
    .filter((r) => r.path.startsWith("/api/v1/"))
    .map((r) => ({ ...r, path: r.path.replace("/api/v1", "") }));
}

test("an organization login saves one token that reaches any project", async () => {
  const home = newHome();
  const finished = await loginToOrganization(home);

  expect(requests[0]).toMatchObject({
    path: "/api/auth/device",
    body: {
      supports: ["organization-token"],
      organization: "acme",
      scopes: [
        "read",
        "scans:launch",
        "findings:write",
        "guidance:write",
        "projects:write",
        "repositories:write",
      ],
    },
  });
  expect(finished.stdout).toContain(
    'Authorized for every project of organization "Acme" (org-1).'
  );
  expect(finished.stdout).toContain("zkao projects list");
  expect(finished.stdout).toContain("zkao config use <projectId>");
  expect(finished.stdout + finished.stderr).not.toContain("orgsecret");

  const configFile = join(home, ".zkao", "config.json");
  expect(statSync(configFile).mode & 0o777).toBe(0o600);
  const config = readConfig(home);
  expect(config.organizations).toEqual({
    "org-1": {
      token: ORG_TOKEN,
      baseUrl: `${server.url}api/v1`,
      name: "Acme",
      slug: "acme",
    },
  });
  expect(config.organizationId).toBe("org-1");
  expect(config.token).toBeUndefined();

  // No project is chosen yet: the error says how to choose one.
  const unchosen = await cli(home, ["repos"]);
  expect(unchosen.status).toBe(1);
  expect(unchosen.stderr).toContain("zkao projects list");

  requests = [];
  expect((await cli(home, ["repos", "--project", "project-9"])).status).toBe(0);
  const used = await cli(home, ["config", "use", "project-7"]);
  expect(used.status).toBe(0);
  expect(used.stdout).toContain('Active project: project-7, reached with the organization token of "Acme"');
  expect((await cli(home, ["repos"])).status).toBe(0);
  expect(apiRequests()).toEqual([
    { method: "GET", path: "/projects/project-9/repositories", token: ORG_TOKEN, body: null },
    { method: "GET", path: "/projects/project-7/repositories", token: ORG_TOKEN, body: null },
  ]);

  const shown = await cli(home, ["config", "show"]);
  expect(shown.stdout).not.toContain("orgsecret");
  expect(JSON.parse(shown.stdout)).toMatchObject({
    projectId: "project-7",
    savedOrganizations: [
      { organizationId: "org-1", name: "Acme", slug: "acme", active: true },
    ],
  });

  const who = await cli(home, ["whoami"]);
  expect(who.status).toBe(0);
  expect(who.stderr).toBe("");
  expect(JSON.parse(who.stdout)).toMatchObject({
    kind: "organization",
    project: null,
    organization: { id: "org-1" },
  });
});

test("a login without --org still says it can take an organization token", async () => {
  const home = newHome();
  expect((await cli(home, ["login", "--no-wait", "--no-browser"])).status).toBe(0);
  expect((await cli(home, ["login", "--no-wait", "--no-browser", "--org"])).status).toBe(0);
  const [plain, anyOrganization] = requests.map(
    (r) => r.body as { supports?: string[]; organization?: unknown; scopes: string[] }
  );
  expect(plain?.supports).toEqual(["organization-token"]);
  expect(plain && "organization" in plain).toBe(false);
  expect(plain?.scopes).toEqual(["read", "scans:launch", "findings:write", "guidance:write"]);
  expect(anyOrganization?.organization).toBe(true);
});

test("a project's own token wins for that project, and the organization token covers the rest", async () => {
  const home = newHome();
  expect((await cli(home, ["login", "--no-wait", "--no-browser"])).status).toBe(0);
  const project = await cli(home, ["login", "--resume"]);
  expect(project.stdout).toContain("Authorized for project");

  const finished = await loginToOrganization(home);
  expect(finished.stdout).toContain('Active project: "Project One" of organization "Acme" (project-1). It keeps its own token.');

  const config = readConfig(home);
  expect(config.projectId).toBe("project-1");
  expect(config.token).toBe(PROJECT_TOKEN);
  expect(config.projects?.["project-1"]?.token).toBe(PROJECT_TOKEN);
  expect(config.organizations?.["org-1"]?.token).toBe(ORG_TOKEN);

  requests = [];
  expect((await cli(home, ["repos"])).status).toBe(0);
  expect((await cli(home, ["repos", "--project", "project-2"])).status).toBe(0);
  expect((await cli(home, ["repos", "--project", "project-2", "--token", "zkao_proj_flag"])).status).toBe(0);
  expect(apiRequests().map((r) => [r.path, r.token])).toEqual([
    ["/projects/project-1/repositories", PROJECT_TOKEN],
    ["/projects/project-2/repositories", ORG_TOKEN],
    ["/projects/project-2/repositories", "zkao_proj_flag"],
  ]);
});

test("a config file from an older CLI keeps working and survives an organization login", async () => {
  const home = newHome();
  mkdirSync(join(home, ".zkao"));
  writeFileSync(
    join(home, ".zkao", "config.json"),
    JSON.stringify({ token: "zkao_proj_old_secret", projectId: "project-old" })
  );
  expect((await cli(home, ["repos"])).status).toBe(0);
  await loginToOrganization(home);
  requests = [];
  expect((await cli(home, ["repos"])).status).toBe(0);
  expect(apiRequests().map((r) => [r.path, r.token])).toEqual([
    ["/projects/project-old/repositories", "zkao_proj_old_secret"],
  ]);
  expect(readConfig(home).projects?.["project-old"]?.token).toBe("zkao_proj_old_secret");
});

test("the organization commands call the organization routes with the saved token", async () => {
  const home = newHome();
  await loginToOrganization(home);
  requests = [];

  const listed = await cli(home, ["projects", "list", "--limit", "20"]);
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({ total: 1, items: [{ id: "project-2" }] });

  const created = await cli(home, ["projects", "create", "widgets", "--description", "Widget code"]);
  expect(created.status).toBe(0);
  expect(JSON.parse(created.stdout)).toMatchObject({ id: "project-2", name: "widgets" });

  const renamed = await cli(home, ["projects", "rename", "project-2", "gadgets"]);
  expect(JSON.parse(renamed.stdout)).toMatchObject({ name: "gadgets" });

  const added = await cli(home, ["repos", "add", "acme/widget", "--project", "project-2"]);
  expect(added.status).toBe(0);
  expect(JSON.parse(added.stdout)).toMatchObject({ id: "repo-1", readiness: "analyzing" });

  const moved = await cli(home, ["repos", "move", "repo-1", "--to", "project-2"]);
  expect(JSON.parse(moved.stdout)).toMatchObject({ projectId: "project-2", repository: { id: "repo-1" } });

  expect(apiRequests()).toEqual([
    { method: "GET", path: "/organizations/org-1/projects", token: ORG_TOKEN, body: null },
    {
      method: "POST",
      path: "/organizations/org-1/projects",
      token: ORG_TOKEN,
      body: { name: "widgets", description: "Widget code" },
    },
    {
      method: "PATCH",
      path: "/organizations/org-1/projects/project-2",
      token: ORG_TOKEN,
      body: { name: "gadgets" },
    },
    {
      method: "POST",
      path: "/organizations/org-1/projects/project-2/repositories",
      token: ORG_TOKEN,
      body: { owner: "acme", name: "widget" },
    },
    {
      method: "POST",
      path: "/organizations/org-1/repositories/repo-1/move",
      token: ORG_TOKEN,
      body: { projectId: "project-2" },
    },
  ]);

  const malformed = await cli(home, ["repos", "add", "widget", "--project", "project-2"]);
  expect(malformed.status).toBe(1);
  expect(malformed.stderr).toContain("<owner>/<name>");
});

test("a token from the environment has its organization looked up, and a project token is refused", async () => {
  const home = newHome();
  const listed = await cli(home, ["projects", "list"], { ZKAO_API_TOKEN: ORG_TOKEN });
  expect(listed.status).toBe(0);
  expect(apiRequests().map((r) => [r.method, r.path, r.token])).toEqual([
    ["GET", "/token", ORG_TOKEN],
    ["GET", "/organizations/org-1/projects", ORG_TOKEN],
  ]);

  requests = [];
  const refused = await cli(home, ["projects", "create", "widgets"], { ZKAO_API_TOKEN: PROJECT_TOKEN });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("needs an organization token");
  expect(refused.stderr).toContain("zkao login --org");
  expect(apiRequests().map((r) => r.path)).toEqual(["/token"]);

  // A saved project token alone is refused without asking the API.
  expect((await cli(home, ["login", "--no-wait", "--no-browser"])).status).toBe(0);
  expect((await cli(home, ["login", "--resume"])).status).toBe(0);
  requests = [];
  const saved = await cli(home, ["projects", "list"]);
  expect(saved.status).toBe(1);
  expect(saved.stderr).toContain("zkao login --org");
  expect(requests).toEqual([]);
});
