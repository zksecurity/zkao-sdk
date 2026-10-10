import createClient, { type Client } from "openapi-fetch";
import { DEFAULT_BASE_URL, resolveBaseUrlFromEnv } from "./base-url";
import type { components, paths } from "./generated/types";

export { DEFAULT_BASE_URL } from "./base-url";

type Schemas = components["schemas"];

export type Repository = Schemas["Repository"];
export type Scan = Schemas["Scan"];
export type ScanDetail = Schemas["ScanDetail"];
export type Finding = Schemas["Finding"];
export type FindingDetail = Schemas["FindingDetail"];
export type FindingDetailsPage = Schemas["PaginatedFindingDetails"];
export type FindingNote = Schemas["FindingNote"];
export type ScanPreset = Schemas["ScanPreset"];
export type LaunchScanRequest = Schemas["LaunchScanRequest"];
export type LaunchScanResult = Schemas["LaunchScanResult"];
export type CancelScanResult = Schemas["CancelScanResult"];
export type ChangeNote = Schemas["ChangeNote"];
export type Severity = Schemas["Severity"];
export type ResolutionStatus = Schemas["ResolutionStatus"];
export type ResolutionReason = Schemas["ResolutionReason"];
export type TriageStatus = Schemas["TriageStatus"];
export type ScanStatus = Schemas["ScanStatus"];
export type PublishArtifactResult = Schemas["PublishArtifactResult"];
export type RepositoryGuidance = Schemas["RepositoryGuidance"];
export type AuditArea = Schemas["AuditArea"];
export type AuditAreaList = Schemas["AuditAreaList"];
export type DeleteAuditAreaResult = Schemas["DeleteAuditAreaResult"];
export type SetGuidanceResult = Schemas["SetGuidanceResult"];
export type TokenInfo = Schemas["TokenInfo"];
export type BillingBalance = Schemas["BillingBalance"];
export type BillingUsage = Schemas["BillingUsage"];
export type UsageEvent = Schemas["UsageEvent"];
export type UsageEventType = Schemas["UsageEventType"];
export type BillingSummary = Schemas["BillingSummary"];
export type InvestigateReportResult = Schemas["InvestigateReportResult"];
export type Report = Schemas["Report"];
/** The triage statuses a report moves through. */
export type ReportStatus =
  | "NEW"
  | "TRIAGING"
  | "NEEDS_INFO"
  | "ACCEPTED"
  | "DUPLICATE"
  | "REJECTED";
export type Advisory = Schemas["Advisory"];
export type AdvisoryDetail = Schemas["AdvisoryDetail"];
export type AdvisoryAffected = Schemas["AdvisoryAffected"];
export type AdvisoryNotice = Schemas["AdvisoryNotice"];
/** The statuses an advisory moves through. */
export type AdvisoryStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "UNDER_EMBARGO"
  | "PUBLISHED"
  | "WITHDRAWN";
export type UsageMonthSummary = Schemas["UsageMonthSummary"];
export type Paginated<T> = { items: T[]; page: number; limit: number; total: number };

/**
 * Body of `createManualAudit`. Not part of the published OpenAPI spec: the
 * endpoint needs the `admin` scope, which only a zkao site admin can grant.
 */
export type ManualAuditRequest = {
  /** Repository the audit covers. */
  repositoryId: string;
  /** Commit the audit reviewed (7-64 hex characters). */
  commitHash: string;
  commitMessage?: string | null;
  /** Findings YAML, as report-tool's `just export-findings <slug>` prints it. */
  findingsYaml: string;
  /** Report body markdown, shown on the scan page. */
  reportMarkdown?: string | null;
};

export type ManualAuditResult = {
  scanId: string;
  findingsCreated: number;
};

export type ZkaoClientOptions = {
  /** A project API token: `zkao_proj_<keyId>_<secret>`. */
  token: string;
  /** The id of the project the token belongs to. */
  projectId: string;
  /**
   * API base URL, used verbatim. When omitted, resolved from `ZKAO_URL`
   * (see {@link resolveBaseUrlFromEnv}), falling back to production
   * (`https://zkao.io/api/v1`).
   */
  baseUrl?: string;
  /** Optional custom fetch (e.g. for tests or proxies). */
  fetch?: typeof fetch;
};

/** Terminal scan statuses: polling can stop once a scan reaches one of these. */
export const TERMINAL_SCAN_STATUSES: readonly ScanStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export function isTerminalScanStatus(status: ScanStatus): boolean {
  return TERMINAL_SCAN_STATUSES.includes(status);
}

export type WaitForRepositoryReadyOptions = {
  /** First poll delay, in ms (default 5000). Grows with backoff up to maxIntervalMs. */
  intervalMs?: number;
  /** Cap on the poll delay, in ms (default 30000). */
  maxIntervalMs?: number;
  /** Give up after this long, in ms (default 30m). Throws on timeout. */
  timeoutMs?: number;
  /** Abort the wait (e.g. on Ctrl-C). Rejects with the abort reason. */
  signal?: AbortSignal;
};

export type WaitForScanOptions = {
  /** First poll delay, in ms (default 5000). Grows with backoff up to maxIntervalMs. */
  intervalMs?: number;
  /** Cap on the poll delay, in ms (default 30000). */
  maxIntervalMs?: number;
  /** Give up after this long, in ms (default 1h). Throws on timeout. */
  timeoutMs?: number;
  /** Abort the wait (e.g. on Ctrl-C). Rejects with the abort reason. */
  signal?: AbortSignal;
  /** Called with the latest detail on each non-terminal poll (for progress UI). */
  onPoll?: (scan: ScanDetail) => void;
};

/** Thrown for any non-2xx response, carrying the API error envelope. */
export class ZkaoApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ZkaoApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

function unwrap<T>(result: FetchResult<T>): T {
  if (result.response.ok && result.data !== undefined) {
    return result.data;
  }
  const envelope = result.error as
    | { error?: { code?: string; message?: string } }
    | undefined;
  throw new ZkaoApiError(
    result.response.status,
    envelope?.error?.code ?? "error",
    envelope?.error?.message ?? result.response.statusText
  );
}

/**
 * Typed client for one zkao project. Every call is scoped to the project the
 * token belongs to; see https://zkao.io/openapi/v1.yaml for the full contract.
 */
/**
 * Which project (and organization) a token belongs to, plus its scopes and
 * limits. Needs no project id, so it works with a token whose project is
 * unknown. Any valid token may call it.
 */
export async function getTokenInfo(
  options: Omit<ZkaoClientOptions, "projectId">
): Promise<TokenInfo> {
  const http = createClient<paths>({
    baseUrl: options.baseUrl ?? resolveBaseUrlFromEnv() ?? DEFAULT_BASE_URL,
    headers: { Authorization: `Bearer ${options.token}` },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return unwrap(await http.GET("/token"));
}

export class ZkaoClient {
  private readonly http: Client<paths>;
  private readonly projectId: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZkaoClientOptions) {
    this.projectId = options.projectId;
    this.baseUrl = options.baseUrl ?? resolveBaseUrlFromEnv() ?? DEFAULT_BASE_URL;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.http = createClient<paths>({
      baseUrl: this.baseUrl,
      headers: { Authorization: `Bearer ${this.token}` },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /**
   * POST a JSON body to a project route that is not in the generated `paths`.
   * Same error envelope handling as the typed calls.
   */
  private async postUntyped<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(this.projectId)}${path}`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (response.ok && payload !== undefined) {
      return payload as T;
    }
    return unwrap<T>({ error: payload, response });
  }

  private get path() {
    return { projectId: this.projectId };
  }

  // --- Token --------------------------------------------------------------

  /** The calling token, and the project and organization it belongs to. */
  async getTokenInfo(): Promise<TokenInfo> {
    return unwrap(await this.http.GET("/token"));
  }

  // --- Repositories -------------------------------------------------------

  async listRepositories(): Promise<Repository[]> {
    const res = await this.http.GET("/projects/{projectId}/repositories", {
      params: { path: this.path },
    });
    return unwrap(res).repositories;
  }

  /**
   * Block until a repository is ready to scan, then return it.
   *
   * A repository added moments ago is still being analyzed, and launching a
   * scan against it fails with `repository_initializing`. Call this between
   * adding a repository and launching its first scan rather than retrying the
   * launch and swallowing the error.
   */
  async waitForRepositoryReady(
    repositoryId: string,
    opts: WaitForRepositoryReadyOptions = {}
  ): Promise<Repository> {
    const intervalMs = opts.intervalMs ?? 5000;
    const maxIntervalMs = opts.maxIntervalMs ?? 30_000;
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(opts.signal);

      const res = await this.http.GET("/projects/{projectId}/repositories", {
        params: { path: this.path },
        signal: opts.signal,
      });
      const retryAfterMs = parseRetryAfterMs(
        res.response.headers.get("retry-after")
      );

      if (res.response.status !== 429) {
        const repository = unwrap(res).repositories.find(
          (candidate) => candidate.id === repositoryId
        );
        if (!repository) {
          throw new Error(
            `Repository ${repositoryId} is not in this project (or this token's allowlist)`
          );
        }
        if (repository.readiness === "ready") {
          return repository;
        }
      }

      const backoffMs = Math.min(
        maxIntervalMs,
        Math.round(intervalMs * 1.5 ** attempt)
      );
      const baseMs = retryAfterMs ?? backoffMs;
      const delayMs = baseMs + Math.round(Math.random() * baseMs * 0.2);

      if (Date.now() + delayMs > deadline) {
        throw new Error(
          `Timed out waiting for repository ${repositoryId} to be ready after ${timeoutMs}ms`
        );
      }
      await sleep(delayMs, opts.signal);
    }
  }

  /** Read a repository's configured guidance (requires the `read` scope). */
  async getRepositoryGuidance(repositoryId: string): Promise<RepositoryGuidance> {
    const res = await this.http.GET(
      "/projects/{projectId}/repositories/{repositoryId}/guidance",
      { params: { path: { ...this.path, repositoryId } } }
    );
    return unwrap(res);
  }

  /**
   * Set (or clear, with `null`) a repository's guidance (requires the
   * `guidance:write` scope). Pass `expectedContent` for an optimistic
   * compare-and-set: send the content you last read (or `null` for "currently
   * cleared") to get a `409` instead of clobbering a concurrent change. Writing
   * the same content that is already stored is a no-op (`unchanged: true`).
   */
  async setRepositoryGuidance(
    repositoryId: string,
    content: string | null,
    opts: { expectedContent?: string | null } = {}
  ): Promise<SetGuidanceResult> {
    const res = await this.http.PUT(
      "/projects/{projectId}/repositories/{repositoryId}/guidance",
      {
        params: { path: { ...this.path, repositoryId } },
        body:
          "expectedContent" in opts
            ? { content, expectedContent: opts.expectedContent }
            : { content },
      }
    );
    return unwrap(res);
  }

  // --- Audit areas --------------------------------------------------------

  /**
   * List a repository's audit areas (requires the `read` scope).
   *
   * An area is a named subsystem a scan can be scoped to: pass its `key` in
   * `auditAreaKeys` when launching. Sizes come from one branch's map, so an
   * area that map no longer names is returned without one. Defaults to the
   * repository's default branch.
   */
  async listAuditAreas(
    repositoryId: string,
    opts: { branch?: string } = {}
  ): Promise<AuditAreaList> {
    const res = await this.http.GET(
      "/projects/{projectId}/repositories/{repositoryId}/audit-areas",
      {
        params: {
          path: { ...this.path, repositoryId },
          query: opts.branch === undefined ? {} : { branch: opts.branch },
        },
      }
    );
    return unwrap(res);
  }

  /**
   * Add a custom audit area (requires the `guidance:write` scope).
   *
   * An area is a name and a description, never a file list: a scan resolves it
   * against the code at the commit it runs on. The returned `key` is derived
   * from the name.
   */
  async createAuditArea(
    repositoryId: string,
    name: string,
    description?: string | null
  ): Promise<AuditArea> {
    const res = await this.http.POST(
      "/projects/{projectId}/repositories/{repositoryId}/audit-areas",
      {
        params: { path: { ...this.path, repositoryId } },
        body: { name, description: description ?? null },
      }
    );
    return unwrap(res).area;
  }

  /**
   * Delete a custom audit area (requires the `guidance:write` scope). An area
   * a scan's map named is refused with a `409`.
   */
  async deleteAuditArea(
    repositoryId: string,
    areaKey: string
  ): Promise<DeleteAuditAreaResult> {
    const res = await this.http.DELETE(
      "/projects/{projectId}/repositories/{repositoryId}/audit-areas/{areaKey}",
      { params: { path: { ...this.path, repositoryId, areaKey } } }
    );
    return unwrap(res);
  }

  // --- Scans --------------------------------------------------------------

  async listScans(opts: { page?: number; limit?: number } = {}): Promise<Paginated<Scan>> {
    const res = await this.http.GET("/projects/{projectId}/scans", {
      params: { path: this.path, query: { page: opts.page, limit: opts.limit } },
    });
    return unwrap(res);
  }

  async getScan(scanId: string): Promise<ScanDetail> {
    const res = await this.http.GET("/projects/{projectId}/scans/{scanId}", {
      params: { path: { ...this.path, scanId } },
    });
    return unwrap(res).scan;
  }

  /**
   * Poll a scan until it reaches a terminal status (COMPLETED / FAILED /
   * CANCELLED) and return the final detail. Honors the server's `Retry-After`
   * header when present; otherwise backs off exponentially with jitter between
   * `intervalMs` and `maxIntervalMs`. A `429` is treated as "slow down", not an
   * error. Prefer this over a hand-rolled `getScan` loop so the server is not
   * hammered.
   */
  async waitForScan(
    scanId: string,
    opts: WaitForScanOptions = {}
  ): Promise<ScanDetail> {
    const intervalMs = opts.intervalMs ?? 5000;
    const maxIntervalMs = opts.maxIntervalMs ?? 30_000;
    const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(opts.signal);

      const res = await this.http.GET("/projects/{projectId}/scans/{scanId}", {
        params: { path: { ...this.path, scanId } },
        signal: opts.signal,
      });

      const retryAfterMs = parseRetryAfterMs(
        res.response.headers.get("retry-after")
      );

      if (res.response.status !== 429) {
        const scan = unwrap(res).scan;
        if (isTerminalScanStatus(scan.status)) {
          return scan;
        }
        opts.onPoll?.(scan);
      }

      const backoffMs = Math.min(
        maxIntervalMs,
        Math.round(intervalMs * 1.5 ** attempt)
      );
      const baseMs = retryAfterMs ?? backoffMs;
      const delayMs = baseMs + Math.round(Math.random() * baseMs * 0.2);

      if (Date.now() + delayMs > deadline) {
        throw new Error(
          `Timed out waiting for scan ${scanId} to finish after ${timeoutMs}ms`
        );
      }
      await sleep(delayMs, opts.signal);
    }
  }

  async launchScan(body: LaunchScanRequest): Promise<LaunchScanResult> {
    const res = await this.http.POST("/projects/{projectId}/scans", {
      params: { path: this.path },
      body,
    });
    return unwrap(res);
  }

  /**
   * Cancel a running or queued scan. Signals in-flight jobs to stop, marks the
   * scan CANCELLED, and releases its reserved credits. A scan already in a
   * terminal COMPLETED/FAILED state cannot be cancelled.
   */
  async cancelScan(scanId: string): Promise<CancelScanResult> {
    const res = await this.http.POST("/projects/{projectId}/scans/{scanId}/cancel", {
      params: { path: { ...this.path, scanId } },
    });
    return unwrap(res);
  }

  async publishScan(
    scanId: string,
    opts: { withPassword?: boolean } = {}
  ): Promise<PublishArtifactResult> {
    const res = await this.http.POST("/projects/{projectId}/scans/{scanId}/publish", {
      params: { path: { ...this.path, scanId } },
      body: { withPassword: opts.withPassword },
    });
    return unwrap(res);
  }

  /**
   * Record a zkSecurity audit report on the project as a manual audit: a
   * completed scan whose findings are pre-confirmed. Requires the `admin`
   * scope, which only a zkao site admin can grant; any other token gets 404.
   */
  async createManualAudit(body: ManualAuditRequest): Promise<ManualAuditResult> {
    return this.postUntyped<ManualAuditResult>("/manual-audits", body);
  }

  // --- Advisories ---------------------------------------------------------

  /**
   * The project's coordinated-disclosure advisories, newest first.
   */
  async listAdvisories(
    opts: { page?: number; limit?: number; status?: AdvisoryStatus } = {}
  ): Promise<Paginated<Advisory>> {
    const res = await this.http.GET("/projects/{projectId}/advisories", {
      params: {
        path: this.path,
        query: { page: opts.page, limit: opts.limit, status: opts.status },
      },
    });
    return unwrap(res);
  }

  /**
   * One advisory, the versions it affects, and the notices planned for it.
   *
   * A notice the plan is holding back carries `blockedReason`. The commonest
   * one is that no affected range names a fixed version, which only the people
   * who shipped the release can supply.
   */
  async getAdvisory(publicId: string): Promise<AdvisoryDetail> {
    const res = await this.http.GET(
      "/projects/{projectId}/advisories/{publicId}",
      { params: { path: { ...this.path, publicId } } }
    );
    return unwrap(res).advisory;
  }

  // --- Incoming reports ---------------------------------------------------

  /**
   * Reports the programme has received, newest first.
   *
   * `publicId` is what {@link investigateReport} takes. `intakeState` says
   * whether a report has been read and split into claims yet: an
   * investigation waits for `COMPLETE`.
   */
  async listReports(
    opts: { page?: number; limit?: number; status?: ReportStatus } = {}
  ): Promise<Paginated<Report>> {
    const res = await this.http.GET("/projects/{projectId}/reports", {
      params: {
        path: this.path,
        query: { page: opts.page, limit: opts.limit, status: opts.status },
      },
    });
    return unwrap(res);
  }

  /**
   * Check an incoming vulnerability report against the code.
   *
   * Requires the `scans:launch` scope. The report's claims are each checked
   * against the repository, deduplicated against the findings already
   * confirmed there, and given a proof of concept where one can be written.
   * Returns at once with the scan doing the work: poll {@link getScan} and
   * then read its findings.
   *
   * Idempotent. A report already under investigation comes back with the
   * existing scan and `claimsQueued: null`, so a retry costs nothing.
   */
  async investigateReport(publicId: string): Promise<InvestigateReportResult> {
    const res = await this.http.POST(
      "/projects/{projectId}/reports/{publicId}/investigate",
      { params: { path: { ...this.path, publicId } } }
    );
    return unwrap(res);
  }

  // --- Findings -----------------------------------------------------------

  async listFindings(
    opts: { page?: number; limit?: number; scanId?: string } = {}
  ): Promise<Paginated<Finding>> {
    const res = await this.http.GET("/projects/{projectId}/findings", {
      params: {
        path: this.path,
        query: { page: opts.page, limit: opts.limit, scanId: opts.scanId },
      },
    });
    return unwrap(res);
  }

  /**
   * Full detail of many findings in one call: a scan's, a set of ids or `ZK-`
   * labels (at most 50), or both. Returns the findings shown in the app.
   * Requested ids that matched nothing come back in `missing`.
   */
  async listFindingDetails(
    opts: { page?: number; limit?: number; scanId?: string; ids?: string[] } = {}
  ): Promise<FindingDetailsPage> {
    const res = await this.http.GET("/projects/{projectId}/findings/details", {
      params: {
        path: this.path,
        query: {
          page: opts.page,
          limit: opts.limit,
          scanId: opts.scanId,
          ids: opts.ids?.join(","),
        },
      },
    });
    return unwrap(res);
  }

  async getFinding(findingId: string): Promise<FindingDetail> {
    const res = await this.http.GET("/projects/{projectId}/findings/{findingId}", {
      params: { path: { ...this.path, findingId } },
    });
    return unwrap(res).finding;
  }

  async addFindingNote(findingId: string, content: string): Promise<{ noteId: string; findingId: string }> {
    const res = await this.http.POST("/projects/{projectId}/findings/{findingId}/notes", {
      params: { path: { ...this.path, findingId } },
      body: { content },
    });
    return unwrap(res);
  }

  async pinFindingNote(
    findingId: string,
    noteId: string,
    kind: "resolution" = "resolution"
  ): Promise<{ findingId: string; noteId: string | null }> {
    const res = await this.http.POST(
      "/projects/{projectId}/findings/{findingId}/notes/{noteId}/pin",
      { params: { path: { ...this.path, findingId, noteId } }, body: { kind } }
    );
    return unwrap(res);
  }

  async setFindingSeverity(
    findingId: string,
    severity: Severity | null
  ): Promise<{ findingId: string; userSeverity?: Severity | null; effectiveSeverity: Severity }> {
    const res = await this.http.PATCH("/projects/{projectId}/findings/{findingId}/severity", {
      params: { path: { ...this.path, findingId } },
      body: { severity },
    });
    return unwrap(res);
  }

  /**
   * Change a finding's resolution status (requires the `findings:write` scope).
   *
   * `note` attaches free text in the same call. `reason` picks a catalog code
   * instead, recorded as a generated comment; the codes offered depend on the
   * status, and a code from another status is rejected with 400. A `note` takes
   * precedence: pass one or the other. Both are ignored for the open statuses
   * (`NOT_STARTED`, `IN_PROGRESS`).
   */
  async setFindingResolution(
    findingId: string,
    resolutionStatus: ResolutionStatus,
    opts: { note?: ChangeNote; reason?: ResolutionReason } = {}
  ): Promise<{ findingId: string; resolutionStatus: ResolutionStatus }> {
    const res = await this.http.PATCH("/projects/{projectId}/findings/{findingId}/resolution", {
      params: { path: { ...this.path, findingId } },
      body: { resolutionStatus, note: opts.note, reason: opts.reason },
    });
    return unwrap(res);
  }

  async publishFinding(
    findingId: string,
    opts: { noteId?: string; withPassword?: boolean } = {}
  ): Promise<PublishArtifactResult> {
    const res = await this.http.POST("/projects/{projectId}/findings/{findingId}/publish", {
      params: { path: { ...this.path, findingId } },
      body: { noteId: opts.noteId, withPassword: opts.withPassword },
    });
    return unwrap(res);
  }

  // --- Discovery ----------------------------------------------------------

  async listScanPresets(): Promise<ScanPreset[]> {
    const res = await this.http.GET("/projects/{projectId}/scan-presets", {
      params: { path: this.path },
    });
    return unwrap(res).presets;
  }

  // --- Billing ------------------------------------------------------------

  /**
   * Get the project's prepaid credit balance (requires the `read` scope). zkao
   * is pay-as-you-go: `balanceCredits` is the total, `reservedCredits` is held
   * by active scans, and `availableCredits` is what remains for new scans.
   */
  async getBillingBalance(): Promise<BillingBalance> {
    const res = await this.http.GET("/projects/{projectId}/billing/balance", {
      params: { path: this.path },
    });
    return unwrap(res);
  }

  /**
   * List credit-ledger movements for reconciliation (requires the `read`
   * scope). `credits` on each event is signed (negative = spent). Defaults to
   * the last 30 days when `from`/`to` are omitted; the range actually used is
   * echoed back on the response.
   */
  async getBillingUsage(
    opts: { from?: string; to?: string; limit?: number } = {}
  ): Promise<BillingUsage> {
    const res = await this.http.GET("/projects/{projectId}/billing/usage", {
      params: {
        path: this.path,
        query: { from: opts.from, to: opts.to, limit: opts.limit },
      },
    });
    return unwrap(res);
  }

  /**
   * Per-calendar-month (UTC) totals of net credits spent on scans and net
   * credits purchased (requires the `read` scope). Quiet months are returned as
   * zeros; newest month first.
   */
  async getBillingSummary(
    opts: { months?: number } = {}
  ): Promise<UsageMonthSummary[]> {
    const res = await this.http.GET("/projects/{projectId}/billing/summary", {
      params: { path: this.path, query: { months: opts.months } },
    });
    return unwrap(res).months;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Aborted");
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to ms, or null. */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Promise that resolves after `ms`, or rejects if `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
