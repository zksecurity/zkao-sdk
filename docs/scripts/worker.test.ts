import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { prefersMarkdown } from "../public/_worker.js";

test("Markdown negotiation respects explicit types and quality weights", () => {
  for (const [accept, expected] of [
    [null, false],
    ["*/*", false],
    ["text/html,application/xhtml+xml,*/*;q=0.8", false],
    ["text/markdown", true],
    ["TEXT/MARKDOWN; charset=utf-8", true],
    ["text/html,text/markdown", true],
    ["text/html;q=1,text/markdown;q=0.5", false],
    ["text/html;q=0.5,text/markdown;q=1", true],
    ["text/markdown;q=0,*/*;q=1", false],
    ["text/markdown;q=0.5,text/*;q=0.8", false],
    ["text/html;q=0,text/markdown;q=0.5,*/*;q=1", true],
    ["text/markdown;q=invalid", false],
  ] as const) {
    assert.equal(prefersMarkdown(accept), expected, String(accept));
  }
});

function assets(handler: (request: Request) => Response) {
  const requests: Request[] = [];
  return {
    requests,
    ASSETS: {
      async fetch(request: Request) {
        requests.push(request);
        return handler(request);
      },
    },
  };
}

test("document URLs negotiate Markdown and preserve query strings and HEAD", async () => {
  for (const [path, markdown] of [
    ["/", "/index.md"],
    ["/api/operations/listfindings/", "/api/operations/listfindings.md"],
    ["/quickstart", "/quickstart.md"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const env = assets((request) => new Response(request.method === "HEAD" ? null : "# Docs", {
        headers: { "Content-Type": "text/plain", Vary: "Origin" },
      }));
      const response = await worker.fetch(new Request(`https://docs.zkao.io${path}?ref=agent`, {
        method,
        headers: { Accept: "text/markdown" },
      }), env);
      assert.equal(env.requests.length, 1);
      assert.equal(env.requests[0]?.url, `https://docs.zkao.io${markdown}?ref=agent`);
      assert.equal(env.requests[0]?.method, method);
      assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
      assert.equal(response.headers.get("Content-Location"), markdown);
      assert.equal(response.headers.get("Vary"), "Origin, Accept");
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.match(response.headers.get("Link") ?? "", /<\/skill.md>/);
      assert.equal(await response.text(), method === "HEAD" ? "" : "# Docs");
    }
  }
});

test("missing Markdown and HTML asset fallbacks retain the original document response", async () => {
  for (const status of [200, 404]) {
    const env = assets((request) => new Response("HTML", {
      status: new URL(request.url).pathname.endsWith(".md") ? status : 404,
      headers: { "Content-Type": "text/html" },
    }));
    const response = await worker.fetch(new Request("https://docs.zkao.io/missing/", {
      headers: { Accept: "text/markdown" },
    }), env);
    assert.equal(env.requests.length, 2);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Content-Type"), "text/html");
    assert.equal(response.headers.get("Content-Location"), null);
    assert.equal(await response.text(), "HTML");
  }
});

test("browsers keep HTML and assets and other methods pass through unchanged", async () => {
  for (const [path, method, accept] of [
    ["/quickstart/", "GET", "text/html"],
    ["/quickstart/", "POST", "text/markdown"],
    ["/skill.md", "GET", "text/markdown"],
    ["/_astro/style.css", "GET", "text/markdown"],
  ]) {
    const original = new Response("original", { status: 202 });
    const env = assets(() => original);
    const request = new Request(`https://docs.zkao.io${path}`, { method, headers: { Accept: accept } });
    const response = await worker.fetch(request, env);
    assert.deepEqual(env.requests, [request]);
    assert.equal(response.status, 202);
    if (path === "/quickstart/" && method === "GET") {
      assert.equal(response.headers.get("Vary"), "Accept");
    } else {
      assert.equal(response, original);
    }
  }
});
