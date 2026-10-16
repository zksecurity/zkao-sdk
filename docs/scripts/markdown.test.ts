import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("generated API pages have full Markdown and appear in the combined docs", async () => {
  const markdown = await readFile(new URL("../dist/api/operations/listfindings.md", import.meta.url), "utf8");
  assert.match(markdown, /^# /);
  assert.match(markdown, /projectId/);
  assert.match(markdown, /Responses/);
  assert.match(markdown, /200/);
  const full = await readFile(new URL("../dist/llms-full.txt", import.meta.url), "utf8");
  assert.ok(full.includes(markdown.trim()));
});

import { htmlToMarkdown } from "./markdown";

test("every sitemap page has a working Markdown link and is included in the full bundle", async () => {
  const sitemap = await readFile(new URL("../dist/sitemap-0.xml", import.meta.url), "utf8");
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!));
  const full = await readFile(new URL("../dist/llms-full.txt", import.meta.url), "utf8");
  assert.ok(urls.length > 40);
  for (const url of urls) {
    const slug = url.pathname.replace(/^\//, "").replace(/\/$/, "");
    const markdownPath = `${slug || "index"}.md`;
    const markdown = await readFile(new URL(`../dist/${markdownPath}`, import.meta.url), "utf8");
    assert.match(markdown, /^# /, url.href);
    assert.ok(full.includes(markdown.trim()), url.href);
    const html = await readFile(new URL(`../dist/${slug ? `${slug}/` : ""}index.html`, import.meta.url), "utf8");
    // The splash home page has its own links instead of the page-title component.
    if (slug) assert.ok(html.includes(`href="/${markdownPath}"`), url.href);
  }
  const robots = await readFile(new URL("../dist/robots.txt", import.meta.url), "utf8");
  assert.match(robots, /User-agent: \*\nAllow: \//);
  assert.ok(robots.includes(`Sitemap: ${urls[0]!.origin}/sitemap.xml`));
  const index = await readFile(new URL("../dist/sitemap.xml", import.meta.url), "utf8");
  assert.ok(index.includes(`<loc>${urls[0]!.origin}/sitemap-0.xml</loc>`));
});

test("Markdown retains hidden schemas, tab labels, code, and absolute links", async () => {
  const markdown = await htmlToMarkdown(`<main><h1>Launch a scan</h1><div class="sl-markdown-content">
    <script>unwanted()</script><button>Copy</button>
    <starlight-tabs><div role="tablist"><button role="tab">CLI</button><button role="tab">HTTP</button></div>
      <div role="tabpanel"><pre data-language="sh"><code><div>zkao scan</div><div>zkao findings</div></code></pre></div>
      <div role="tabpanel" hidden><p>HTTP instructions</p></div>
    </starlight-tabs>
    <details><summary>Response schema</summary><p>nestedField</p></details>
    <div data-openapi-content-type="application/json" hidden><p>alternateBody</p></div>
    <div class="sl-link-card"><a href="/reference/cli/">CLI reference</a><span class="description">Command help</span></div>
    <a href="../authentication/#scopes">Scopes</a><img src="/_astro/logo.png" alt="logo" />
  </div></main>`, new URL("https://docs.zkao.io/quickstart/"));
  assert.ok(markdown);
  assert.match(markdown, /CLI/);
  assert.match(markdown, /HTTP instructions/);
  assert.match(markdown, /nestedField/);
  assert.match(markdown, /application\/json/);
  assert.match(markdown, /alternateBody/);
  assert.match(markdown, /CLI reference\]\([^\n]+\)\n\nCommand help/);
  assert.match(markdown, /```sh\nzkao scan\nzkao findings/);
  assert.match(markdown, /https:\/\/docs\.zkao\.io\/authentication\/#scopes/);
  assert.match(markdown, /https:\/\/docs\.zkao\.io\/_astro\/logo\.png/);
  assert.doesNotMatch(markdown, /unwanted|Copy|<TabItem/);
});
