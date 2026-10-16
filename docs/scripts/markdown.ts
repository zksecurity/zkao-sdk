import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import type { Element, Root } from "hast";
import { select, selectAll } from "hast-util-select";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { remove } from "unist-util-remove";

function text(value: string): Element {
  return { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value }] };
}

export async function htmlToMarkdown(html: string, url: URL): Promise<string | undefined> {
  const tree = unified().use(rehypeParse).parse(html) as Root;
  const content = select("main .sl-markdown-content", tree);
  const title = select("main h1", tree);
  if (!content || !title) return;
  tree.children = [title, content];

  // Hidden panels contain alternate examples and response schemas.
  for (const panel of selectAll("[hidden], details", tree)) {
    delete panel.properties.hidden;
    if (panel.tagName === "details") panel.properties.open = true;
  }
  for (const tabs of selectAll("starlight-tabs", tree)) {
    const labels = selectAll('[role="tab"]', tabs);
    const panels = selectAll('[role="tabpanel"]', tabs);
    tabs.tagName = "div";
    tabs.children = panels.flatMap((panel, index) => {
      const label = labels[index];
      if (!label) return [panel];
      label.tagName = "p";
      label.properties = {};
      return [label, panel];
    });
  }
  for (const panel of selectAll("[data-openapi-content-type]", tree)) {
    panel.children.unshift(text(String(panel.properties.dataOpenapiContentType)));
  }
  for (const input of selectAll("input[value]", tree)) {
    input.tagName = "code";
    input.children = [{ type: "text", value: String(input.properties.value) }];
    input.properties = {};
  }
  for (const keys of selectAll(".sl-openapi-keys", tree)) keys.tagName = "ul";
  for (const key of selectAll(".sl-openapi-key", tree)) key.tagName = "li";
  for (const description of selectAll(".sl-link-card .description", tree)) description.tagName = "p";
  for (const type of selectAll(".sl-openapi-type, .sl-openapi-tag", tree)) {
    type.children.push({ type: "text", value: " " });
  }
  for (const pre of selectAll("pre", tree)) {
    const code = select("code", pre);
    if (code && typeof pre.properties.dataLanguage === "string") {
      code.properties.className = [`language-${pre.properties.dataLanguage}`];
    }
  }
  remove(tree, (node) => node.type === "comment");
  for (const selector of ["script", "style", "svg", "button", "select", ".sr-only", ".sl-anchor-link", ".md-actions", ".sl-openapi-content-picker-select"]) {
    const nodes = new Set(selectAll(selector, tree));
    remove(tree, (node) => nodes.has(node as Element));
  }
  for (const element of selectAll("a[href], img[src]", tree)) {
    const key = element.tagName === "a" ? "href" : "src";
    const value = element.properties[key];
    if (typeof value === "string") element.properties[key] = new URL(value, url).href;
  }
  const processor = unified().use(rehypeRemark).use(remarkGfm).use(remarkStringify);
  return `${processor.stringify(await processor.run(tree)).trim()}\n`;
}

async function htmlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") && entry.name !== "404.html" ? [path] : [];
  }));
  return files.flat().sort();
}

export default function markdown(): AstroIntegration {
  let site: URL;
  return {
    name: "zkao-docs-markdown",
    hooks: {
      "astro:config:done": ({ config }) => {
        if (!config.site) throw new Error("Markdown docs require a site URL");
        site = new URL(config.site);
      },
      "astro:build:done": async ({ dir }) => {
        const root = fileURLToPath(dir);
        const pages: { url: URL; markdown: string; title: string }[] = [];
        for (const file of await htmlFiles(root)) {
          const path = relative(root, file).replace(/index\.html$/, "").replace(/\.html$/, "");
          const url = new URL(path, site);
          const output = await htmlToMarkdown(await readFile(file, "utf8"), url);
          if (!output) continue;
          const slug = path.replace(/\/$/, "") || "index";
          await writeFile(join(root, `${slug}.md`), output);
          pages.push({ url, markdown: output, title: output.split("\n")[0]?.replace(/^# /, "") ?? path });
        }
        if (!pages.length) throw new Error("No documentation pages found for Markdown generation");
        await writeFile(join(root, "llms-full.txt"), pages.map((page) => `Source: ${page.url.href}\n\n${page.markdown}`).join("\n---\n\n"));
        const index = await readFile(join(root, "llms.txt"), "utf8");
        const api = pages.filter((page) => page.url.pathname.startsWith("/api/"));
        await writeFile(join(root, "llms.txt"), `${index.trim()}\n\n## API reference\n\n${api.map((page) => `- [${page.title}](${page.url.href})`).join("\n")}\n`);
      },
    },
  };
}
