// @ts-check

/** @param {string | null} accept */
export function prefersMarkdown(accept) {
  const ranges = (accept ?? "").split(",").map((entry) => {
    const [type = "", ...parameters] = entry.toLowerCase().split(";");
    const value = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="))
      ?.slice(2).trim();
    const quality = value === undefined ? 1
      : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    return { type: type.trim(), quality };
  });
  if (!ranges.some(({ type }) => type === "text/markdown")) return false;
  /** @param {string} type */
  const qualityFor = (type) => {
    for (const candidate of [type, "text/*", "*/*"]) {
      const matches = ranges.filter((range) => range.type === candidate);
      if (matches.length) return Math.max(...matches.map((range) => range.quality));
    }
    return 0;
  };
  const markdown = qualityFor("text/markdown");
  return markdown > 0 && markdown >= qualityFor("text/html");
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch(request: Request): Promise<Response> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const document = !url.pathname.split("/").at(-1)?.includes(".");
    if (!["GET", "HEAD"].includes(request.method) || !document) {
      return env.ASSETS.fetch(request);
    }

    let response;
    let markdownPath;
    if (prefersMarkdown(request.headers.get("Accept"))) {
      const markdownUrl = new URL(url);
      markdownUrl.pathname = url.pathname === "/" ? "/index.md"
        : `${url.pathname.replace(/\/$/, "")}.md`;
      const markdownRequest = new Request(markdownUrl, request);
      const candidate = await env.ASSETS.fetch(markdownRequest);
      const type = candidate.headers.get("Content-Type") ?? "";
      if (candidate.ok && /^(text\/(markdown|plain)|application\/octet-stream)(;|$)/i.test(type)) {
        response = candidate;
        markdownPath = markdownUrl.pathname;
      } else {
        await candidate.body?.cancel();
      }
    }
    response ??= await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.append("Vary", "Accept");
    headers.set("Cache-Control", "private, no-store");
    headers.append("Link", `</llms.txt>; rel="describedby"; type="text/plain", </skill.md>; rel="describedby"; type="text/markdown"`);
    if (markdownPath) {
      headers.set("Content-Type", "text/markdown; charset=utf-8");
      headers.set("Content-Location", markdownPath);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
