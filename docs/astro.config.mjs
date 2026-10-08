// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightOpenAPI, { openAPISidebarGroups } from "starlight-openapi";

export default defineConfig({
  site: "https://docs.zkao.io",
  integrations: [
    starlight({
      title: "zkao docs",
      description:
        "Drive zkao security audits from code: the REST API, the zkao CLI, the TypeScript SDK, the GitHub Action, and the agent skill.",
      logo: {
        light: "./src/assets/logo-light.png",
        dark: "./src/assets/logo-dark.png",
        alt: "zkao",
        replacesTitle: true,
      },
      favicon: "/favicon.png",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/zksecurity/zkao-sdk" },
      ],
      editLink: {
        baseUrl: "https://github.com/zksecurity/zkao-sdk/edit/main/docs/",
      },
      customCss: [
        "@fontsource/ibm-plex-sans/400.css",
        "@fontsource/ibm-plex-sans/500.css",
        "@fontsource/ibm-plex-sans/600.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource-variable/space-grotesk",
        "./src/styles/theme.css",
      ],
      components: {
        PageTitle: "./src/components/PageTitle.astro",
      },
      plugins: [
        starlightOpenAPI([
          {
            base: "api",
            schema: "../openapi/v1.yaml",
            sidebar: { label: "Endpoints", collapsed: false },
          },
        ]),
        starlightLlmsTxt({
          projectName: "zkao",
          details:
            "zkao audits code repositories for security bugs, with a focus on cryptography and zero-knowledge circuits. A project API token drives one project: list repositories, launch and poll scans, triage findings, edit repository guidance, read credit usage, and publish results. Every page is also served as Markdown at its URL with `.md` appended. The agent skill is at https://docs.zkao.io/skill.md and the OpenAPI spec at https://docs.zkao.io/openapi/v1.yaml.",
        }),
      ],
      sidebar: [
        {
          label: "Get started",
          items: ["index", "quickstart", "authentication", "environments"],
        },
        {
          label: "Guides",
          items: [
            "guides/scans",
            "guides/diff-scans",
            "guides/findings",
            "guides/guidance",
            "guides/credits",
            "guides/publishing",
            "guides/github-action",
            "guides/agents",
          ],
        },
        {
          label: "Reference",
          items: ["reference/cli", "reference/sdk", "reference/api-conventions"],
        },
        { label: "API reference", items: openAPISidebarGroups },
      ],
    }),
  ],
});
