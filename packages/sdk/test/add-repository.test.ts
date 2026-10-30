import { describe, expect, test } from "bun:test";
import { ZkaoApiError, ZkaoClient } from "../src/client";

describe("addRepository", () => {
  test("continues to list repositories through the read endpoint", async () => {
    const repo = { id: "repo-1", owner: "noir-lang", name: "noir" };
    let method = "";
    const client = new ZkaoClient({
      token: "test-token",
      projectId: "project-1",
      baseUrl: "https://example.invalid/api/v1",
      fetch: async (input) => {
        method = (input as Request).method;
        return Response.json({ repositories: [repo] });
      },
    });
    expect(await client.listRepositories()).toEqual([repo]);
    expect(method).toBe("GET");
  });

  test("sends the repository URL within the configured project", async () => {
    let request: Request | undefined;
    const repo = { id: "repo-1", owner: "noir-lang", name: "noir" };
    const client = new ZkaoClient({
      token: "test-token",
      projectId: "project-1",
      baseUrl: "https://example.invalid/api/v1",
      fetch: async (input) => {
        request = input as Request;
        return Response.json({ repository: repo }, { status: 201 });
      },
    });

    expect(await client.addRepository("https://github.com/noir-lang/noir")).toEqual(repo);
    expect(request?.method).toBe("POST");
    expect(new URL(request!.url).pathname).toBe("/api/v1/projects/project-1/repositories");
    expect(await request!.json()).toEqual({ repoUrl: "https://github.com/noir-lang/noir" });
  });

  test("preserves a rejected authorization response", async () => {
    const client = new ZkaoClient({
      token: "test-token",
      projectId: "project-1",
      baseUrl: "https://example.invalid/api/v1",
      fetch: async () => Response.json({ error: { code: "forbidden", message: "Missing scope" } }, { status: 403 }),
    });
    await expect(client.addRepository("https://github.com/noir-lang/noir"))
      .rejects.toBeInstanceOf(ZkaoApiError);
  });
});
