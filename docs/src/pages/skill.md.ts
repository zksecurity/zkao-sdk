import { readFile } from "node:fs/promises";
import type { APIRoute } from "astro";

// The agent skill, served from a stable URL instead of a raw GitHub link.
export const GET: APIRoute = async () =>
  new Response(await readFile("../skills/zkao/SKILL.md", "utf8"), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
