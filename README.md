# zkao SDK & CLI

Programmatically control a [zkao](https://zkao.io) security-audit **project** with
a project API token: list repositories, launch and poll scans, read and triage
findings, and publish results.

This repo contains three things, all driven by one OpenAPI contract:

| Package / dir        | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `packages/sdk` (`@zksecurity/zkao-sdk`) | Typed TypeScript client, generated from the OpenAPI spec. |
| `packages/cli` (`@zksecurity/zkao-cli`) | Command-line interface over the SDK (installs a `zkao` command). |
| `skills/zkao`        | An agent **skill** (`SKILL.md`) so AI agents can drive the API.    |
| `openapi/v1.yaml`    | The OpenAPI 3.1 contract (source of truth lives in the zkao app).  |

## Get credentials

Easiest is `zkao login`: it opens a browser device-authorization flow where you
pick a project and approve, then saves the token and project id to
`~/.zkao/config.json`. No token to copy.

Or create one yourself in zkao under **Project Settings → API tokens**: it is
scoped to one project, carries a chosen set of permissions (`read`,
`findings:write`, `guidance:write`, `scans:launch`, `publish`), and can be
limited to specific repositories. The token (`zkao_proj_…`) is shown once.

To target another environment, set `ZKAO_URL` to a host, origin, or full API URL
(e.g. `staging.zkao.io`); the CLI and SDK derive the API base (`…/api/v1`) from
it.

## CLI

Install the `@zksecurity/zkao-cli` package; it provides a `zkao` command.

```bash
npm install -g @zksecurity/zkao-cli                         # or run one-off: npx @zksecurity/zkao-cli <args>

zkao login                                       # browser approval; saves credentials
# or: zkao config set --token zkao_proj_… --project <projectId>
# or: export ZKAO_API_TOKEN and ZKAO_PROJECT_ID

zkao repos
zkao findings list
zkao findings resolution <findingId> WONT_FIX --reason risk_accepted
zkao scans launch --repo <repoId> --budget 500 --preset <ref>
zkao scans wait <scanId>                         # block until the scan finishes
zkao scans cancel <scanId>                       # cancel a running or queued scan
zkao guidance get <repoId>                       # read a repo's guidance
zkao guidance set <repoId> <file|->              # update it (guidance:write scope)
zkao billing balance                             # credits available for new scans
zkao billing usage                               # credit ledger, last 30 days
zkao billing summary                             # credits spent/purchased per month
```

`zkao --help` lists every command. All output is JSON.

For non-interactive callers (agents, CI), split the login so nothing blocks:
`zkao login --no-wait --no-browser` prints the URL/code and exits, then
`zkao login --resume` polls once and exits (repeat until it prints `Authorized`).

## SDK

```bash
npm install @zksecurity/zkao-sdk
```

```ts
import { ZkaoClient } from "@zksecurity/zkao-sdk";

const zkao = new ZkaoClient({
  token: process.env.ZKAO_API_TOKEN!,
  projectId: process.env.ZKAO_PROJECT_ID!,
});

const findings = await zkao.listFindings({ limit: 20 });
const { scanId } = await zkao.launchScan({
  repositoryId,
  creditBudget: 500,
  presetRef,
});

// Block until the scan finishes. Backs off and honors the server's Retry-After
// instead of polling in a tight loop.
const scan = await zkao.waitForScan(scanId, {
  onPoll: (s) => console.log(s.status),
});
```

Every method is fully typed from the OpenAPI spec. Non-2xx responses throw
`ZkaoApiError` (with `.status` and `.code`). The base URL is taken from the
`baseUrl` option, else `ZKAO_URL`, else production.

## Agent skill

`skills/zkao/SKILL.md` teaches an AI agent how to drive the API (auth, the CLI,
direct HTTP, and common workflows like triage and launch-and-poll).

- **Claude Code (plugin):** add this repo as a marketplace and install the plugin:
  ```
  /plugin marketplace add zksecurity/zkao-sdk
  /plugin install zkao@zkao
  ```
- **Any agent (manual):** copy `skills/zkao/SKILL.md` into your agent's skills
  directory, and point the agent at `https://zkao.io/openapi/v1.yaml` for the
  full contract.

## Developing

```bash
bun install
bun run generate    # regenerate SDK types from openapi/v1.yaml
bun run typecheck
bun run build
```

The SDK types in `packages/sdk/src/generated/` are generated from
`openapi/v1.yaml`; CI fails if they are stale. The spec's source of truth is the
zkao app (served at `/openapi/v1.yaml`); update `openapi/v1.yaml` here to match a
new API version, regenerate, and bump the package versions.

## Publishing

`@zksecurity/zkao-sdk` and `@zksecurity/zkao-cli` are published to npm independently, both under the
public `@zksecurity` scope (`publishConfig.access` is already `public`). Use `bun
publish`, which rewrites the CLI's `workspace:*` dependency to the resolved
version (plain `npm publish` would ship the literal `workspace:*` and break
installs). Publish the SDK first so the CLI's dependency resolves:

```bash
bun run build
cd packages/sdk && bun publish
cd ../cli && bun publish
```

Bump the version in each package before publishing.
