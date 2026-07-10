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
zkao scans wait <scanId>                    # block until the scan finishes
zkao scans cancel <scanId>                  # cancel a running or queued scan
zkao findings list --scan <scanId>
```

All output is JSON. `zkao --help` lists every command. Credentials come from
`zkao login`, `zkao config set`, or the `ZKAO_API_TOKEN` / `ZKAO_PROJECT_ID`
environment variables. Point at another environment with `ZKAO_URL`.

Full docs and the SDK (`@zksecurity/zkao-sdk`): **https://github.com/zksecurity/zkao-sdk**

## License

MIT
