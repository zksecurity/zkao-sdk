# @zksecurity/zkao-sdk

Typed TypeScript client for the [zkao](https://zkao.io) Project API. Drive a
single zkao security-audit project with a project API token: list repositories,
launch and poll scans, read and triage findings, and publish results.

```bash
npm install @zksecurity/zkao-sdk
```

```ts
import { ZkaoClient } from "@zksecurity/zkao-sdk";

const zkao = new ZkaoClient({
  token: process.env.ZKAO_API_TOKEN!,
  projectId: process.env.ZKAO_PROJECT_ID!,
});

const { scanId } = await zkao.launchScan({ repositoryId, creditBudget: 500 });
const scan = await zkao.waitForScan(scanId, { onPoll: (s) => console.log(s.status) });
const findings = await zkao.listFindings({ scanId });
```

Every method is fully typed from the OpenAPI spec. Non-2xx responses throw
`ZkaoApiError` (with `.status` and `.code`). The base URL comes from the
`baseUrl` option, else `ZKAO_URL`, else production.

Cancel a running or queued scan with `zkao.cancelScan(scanId)`; you are charged
only for analysis already done and the rest of the reserved budget is released.

Full docs, the CLI (`@zksecurity/zkao-cli`), and the OpenAPI contract:
**https://github.com/zksecurity/zkao-sdk**

## License

MIT
