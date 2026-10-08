import { readFile } from "node:fs/promises";
import type { APIRoute } from "astro";

export const GET: APIRoute = async () =>
  new Response(await readFile("../openapi/v1.yaml", "utf8"), {
    headers: { "Content-Type": "application/yaml; charset=utf-8" },
  });
