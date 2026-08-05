---
name: zkao
description: >-
  Control a zkao security-audit project programmatically: list repositories,
  list/launch/poll scans, list and read findings, triage findings (comment,
  change severity, change resolution status, pin a note), read and update a
  repository's guidance, check the credit balance and usage, and publish
  findings or scans. Use when the user asks to drive their zkao project, check
  scan status, review or triage findings, kick off a scan, edit repo guidance,
  check credits or spend, or publish results.
---

# zkao project API

Drive a single zkao project over its REST API using a project **API token**.
You can call the API two ways: the `zkao` CLI (preferred for shells) or direct
HTTP requests (curl/fetch). The full machine-readable contract is the OpenAPI
spec at `https://zkao.io/openapi/v1.yaml`.

## Setup

Install the CLI (Node 18+), then authorize it:

```
curl -fsSL https://raw.githubusercontent.com/zksecurity/zkao-sdk/main/install.sh | bash
```

This installs the published `@zksecurity/zkao-cli` package and the `zkao`
binary. For a one-off without installing, prefix any command with
`npx @zksecurity/zkao-cli`. `zkao --help` and `zkao <group> --help` are the
authoritative, always-current list of commands.

Two ways to get credentials. If the user asks to "create/get a token" and
browser approval is acceptable, **prefer the CLI device flow first** (option 1
below). Do **not** ask them to manually create or copy an API token unless the
device flow is unavailable or they specifically request a long-lived/manual
token.

- **Browser approval (no token to copy):** authorize over the device flow when
  nothing is configured yet. Don't run a bare `zkao login`: it blocks for
  minutes waiting on the browser and will hit a command timeout. Instead:
  1. Run `zkao login --no-wait --no-browser`. It prints a URL and a code and
     returns immediately.
  2. Give the user the URL and code, and ask them to open it, pick a project,
     and approve.
  3. After they confirm, run `zkao login --resume`. Repeat it on your own cadence
     until it prints `Authorized` (each call returns at once; `Still waiting
     for approval` means keep waiting). The token and project id are then saved
     to `~/.zkao/config.json`.
- **Pre-made token:** the user creates one under **Project Settings → API
  tokens** (scoped to one project, chosen permissions, optionally specific
  repos), shown once as `zkao_proj_<keyId>_<secret>`, and provides it via env:
  - `ZKAO_API_TOKEN` — the token
  - `ZKAO_PROJECT_ID` — the project id (visible in the project URL)

To target a non-production environment, set `ZKAO_URL` to a host, origin, or
full API URL (e.g. `staging.zkao.io`); the CLI and SDK derive the API base from
it.

Never print the token back to the user or write it into files.

## Auth & scoping (what to expect)

- Send the token as `Authorization: Bearer <token>`. Header only, never in the URL.
- A token carries a subset of scopes: `read`, `findings:write`, `guidance:write`,
  `scans:launch`, `publish`. A `403` means the token lacks the scope for that action.
- A token is bound to one project (and possibly a subset of its repos). Anything
  outside its scope returns `404` (it is not revealed to exist), not `403`.
- Errors are `{ "error": { "code": "...", "message": "..." } }`. A `401` means the
  token is missing/invalid/expired/revoked.

## CLI

Install once with `npm install -g @zksecurity/zkao-cli` (provides the `zkao` command).

```
zkao login                                        # browser device flow; saves token + project
zkao config set --token <token> --project <id>    # or set credentials directly / use env vars
zkao repos                                        # list repositories
zkao presets                                      # scan presets (use a ref to launch)
zkao flows                                        # opt-in flows
zkao scans launch --repo <repoId> --budget <credits> [--preset <ref>] [--branch <b>] [--flow <id>]
zkao scans get <scanId>                           # one-shot status (QUEUED→PROCESSING→COMPLETED)
zkao scans wait <scanId>                          # block until the scan finishes (paced backoff)
zkao scans cancel <scanId>                         # cancel a running or queued scan
zkao scans list
zkao findings list [--scan <scanId>]
zkao findings get <findingId>                     # full detail incl. PoC + notes
zkao findings comment <findingId> "<text>"
zkao findings severity <findingId> <CRITICAL|HIGH|MEDIUM|LOW|INFO|none>
zkao findings resolution <findingId> <RESOLVED|WONT_FIX|FALSE_POSITIVE|...> [--note "<text>"] [--reason <code>]
zkao findings publish <findingId> [--note <noteId>] [--password]
zkao scans publish <scanId> [--password]
zkao guidance get <repoId>                        # show a repo's configured guidance
zkao guidance set <repoId> <file|->               # set guidance from a file or stdin
zkao guidance clear <repoId>                      # remove a repo's guidance
zkao billing balance                              # credits available for new scans
zkao billing usage [--from <d>] [--to <d>]        # credit ledger, last 30 days by default
zkao billing summary [--months <n>]               # credits spent/purchased per month
```

`zkao scans launch` also takes `--guidance <file|->` to set per-scan guidance.

Every command prints JSON on stdout. `zkao <group> --help` lists subcommands.

A `zkao: version X is available` line on stderr means this file is behind the
API too. Install the newer CLI and refresh this skill from
`https://github.com/zksecurity/zkao-sdk`: recent releases may add commands and
capabilities described nowhere here.

## Common workflows

**Triage findings from the latest scan**
1. `zkao scans list` → take the most recent `COMPLETED` scan id.
2. `zkao findings list --scan <scanId>` → review titles/severities.
3. For each, `zkao findings get <findingId>` to read the description and PoC.
4. Triage: `zkao findings comment ...`, `zkao findings severity ...`,
   `zkao findings resolution ...`.

When the user gives a reason or extra context for a resolution or severity
change, record it alongside the change: the status alone captures the outcome,
not the why. `zkao findings resolution <id> <status> --note "<text>"` attaches
it in the same call (the resolution PATCH takes the same `note` over HTTP/SDK).

For a plain, categorical why, `--reason <code>` records a catalog entry instead.
The codes offered depend on the status, and a code from another status is
rejected with the valid list in the error. See the `ResolutionReason` enum in
the OpenAPI spec for the full set. Prefer `--note` when the reasoning has any
detail worth keeping; a code alone loses it.

**Route durable repo knowledge into guidance**

Scan agents read repo-specific guidance (scoping, build quirks, project
context, known non-issues) that layers over any `zkao.md` committed at the repo
root. When triage surfaces knowledge that applies to the whole repo rather than
one finding, a comment on a single finding will not carry it forward: it belongs
in the repository's guidance so every future scan reads it.

Read the current guidance with `zkao guidance get <repoId>` and update it with
`zkao guidance set <repoId> <file|->`. Prefer editing the existing text over
replacing it: read it first, add your note, and write the merged result back
(`set` refuses to overwrite a guidance that changed since you read it unless you
pass `--force`, so a concurrent edit surfaces as a conflict rather than being
lost). Keep guidance lean, since every line is read on every scan. A guidance
change is durable and affects all future scans, so when the knowledge is
substantial or judgment-heavy, propose the text to the user before writing it.

Setting guidance requires a `guidance:write` token; a read-only token can only
`get` it. Separately, `zkao scans launch --guidance <file|->` sets guidance for
a single scan, replacing the stored repo guidance for that run only.

**Launch a scan and wait for it**
1. `zkao repos` → repo id; `zkao presets` → a preset `ref`.
2. `zkao scans launch --repo <id> --budget <credits> --preset <ref>` → `scanId`.
3. `zkao scans wait <scanId>` to block until it finishes. Prefer this over a
   manual `zkao scans get` loop: scans take minutes, and a tight poll loop is
   rejected with `429`. If you must poll by hand, honor the `Retry-After` header
   on the scan response (the SDK's `waitForScan` does this for you).

**Check what a scan can cost before launching**

zkao is pay-as-you-go: a scan reserves its budget in credits up front, and a
launch fails when the project cannot cover it. `zkao billing balance` reports
`availableCredits` (what is left after active scans hold their reservations),
so check it before choosing `--budget`. `zkao billing usage` lists the ledger
movements behind a balance the user disputes, and `zkao billing summary` gives
per-month spend. Credits are the only unit here: never convert them to money.

## Direct HTTP (no CLI)

Base: `https://zkao.io/api/v1/projects/{projectId}`. Examples:

```bash
curl -H "Authorization: Bearer $ZKAO_API_TOKEN" \
  https://zkao.io/api/v1/projects/$ZKAO_PROJECT_ID/findings

curl -X POST -H "Authorization: Bearer $ZKAO_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"repositoryId":"<id>","creditBudget":500,"presetRef":"<ref>"}' \
  https://zkao.io/api/v1/projects/$ZKAO_PROJECT_ID/scans
```

List endpoints (`scans`, `findings`) paginate with `?page=&limit=` (max 100) and
return `{ items, page, limit, total }`. See the OpenAPI spec for every endpoint,
request body, and response shape.
