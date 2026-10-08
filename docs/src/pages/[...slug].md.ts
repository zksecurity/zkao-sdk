import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

// Serves every docs page as raw Markdown at its URL plus `.md`, for agents.
export const getStaticPaths = (async () => {
  const pages = await getCollection("docs");
  return pages.map((page) => ({
    params: { slug: page.id === "" ? "index" : page.id },
    props: { page },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: CollectionEntry<"docs"> }> = ({ props }) => {
  const { title, description } = props.page.data;
  const header = description ? `# ${title}\n\n> ${description}\n\n` : `# ${title}\n\n`;
  return new Response(header + (props.page.body ?? ""), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
