# @zksecurity/zkao-cli

Command-line interface for the [zkao](https://zkao.io) Project API. Launch and
poll scans, read and triage findings, and publish results from your terminal or
CI. Installs a `zkao` command.

```bash
npm install -g @zksecurity/zkao-cli
# or run without installing:
npx @zksecurity/zkao-cli --help
```

```bash
zkao login                                  # browser approval; saves credentials
zkao repos
zkao scans launch --repo <repoId> --budget 500 --preset <ref>
zkao scans launch --repo <repoId> --preset "builtin:Diff Scan" --base main --commit <sha>
zkao scans wait <scanId>                    # block until the scan finishes
zkao scans get <scanId>                     # check triage completeness
zkao scans resume-triage <scanId> --budget <credits> --idempotency-key <key>
zkao scans triage-wait <scanId> <runId>       # wait for the returned triage run
zkao scans cancel <scanId>                  # cancel a running or queued scan
zkao findings list --scan <scanId>
```

All output is JSON. `zkao --help` lists every command. Credentials come from
`zkao login`, `zkao config set`, or the `ZKAO_API_TOKEN` / `ZKAO_PROJECT_ID`
environment variables. Point at another environment with `ZKAO_URL`.

Check `triage` before treating a completed scan as fully reviewed.
Resume only within its offered budget range and your authorized spending limit.
Reuse the same key and budget when retrying a resumption.
After resumed triage finishes, check the scan's `triage` again.
Use `--json-errors` for API error status, code, and message as JSON on stderr.

Full docs and the SDK (`@zksecurity/zkao-sdk`): **https://github.com/zksecurity/zkao-sdk**

## License

MIT
