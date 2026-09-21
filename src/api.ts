// Cloudflare Browser Run REST client.
// Quick Actions are one-shot HTTP calls: headless Chrome on CF's network
// renders the URL and returns markdown / PNG / PDF. No Workers needed —
// a scoped API token is enough.
//
// Endpoints (v4 API):
//   POST /accounts/{ACCOUNT_ID}/browser-rendering/{screenshot|markdown|pdf}
//   POST /accounts/{ACCOUNT_ID}/browser-rendering/crawl
//   GET  /accounts/{ACCOUNT_ID}/browser-rendering/crawl/{jobId}
//
// Security: URL strictness first — only public http(s), localhost / private
// / reserved IPs / IPv6 literals / userinfo are rejected (SSRF guard).

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const homedirPath = (): string => homedir();
const joinPath = (...parts: string[]): string => join(...parts);

export type Action = "markdown" | "screenshot" | "pdf";

export type ApiResult =
  | { ok: true; action: Action; content: string | Uint8Array }
  | { ok: false; action?: Action; content?: undefined; error: string };

const MAX_URL_LENGTH = 2048;
const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "::" || ip === "0.0.0.0") return true;
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false; // hostname, not an IP
  const parts = ip.split(".").map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0) || // 192.0.0.0/24 (incl. IETF)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast/reserved
  );
}

/** Reject non-http(s), oversized, userinfo, or SSRF-prone URLs. */
export function assertSafeUrl(raw: string): string {
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error("url too long or empty");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https allowed");
  if (u.username || u.password) throw new Error("userinfo not allowed");
  if (u.hostname === "localhost") throw new Error("localhost not allowed");
  const host = u.hostname.toLowerCase();
  if (/\.local$/.test(host)) throw new Error("local hostnames not allowed");
  const ipCandidate = host.replace(/^\[|\]$/g, "");
  if (ipCandidate.includes(":")) throw new Error("IPv6 literal not allowed");
  if (isPrivateIp(ipCandidate)) throw new Error("private/reserved IP not allowed");
  return u.toString();
}

export interface BrowserRunConfig {
  apiToken: string;
  accountId: string;
  apiBase?: string;
}

/** Read credentials from ~/.pi/agent/cloudflare-browser-run.json.
 *  Keys use the `a_b_c` form: cf_api_token / cf_account_id / cf_api_base.
 *  `configPath` is injectable for tests. Returns a config or a setup-hint
 *  error. */
export function loadConfig(configPath?: string): BrowserRunConfig | { error: string } {
  let file: Record<string, string> = {};
  const p = configPath ?? joinPath(homedirPath(), ".pi", "agent", "cloudflare-browser-run.json");
  try {
    file = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  } catch {
    // no config file — nothing to read
  }
  const apiToken = file["cf_api_token"] ?? file.apiToken;
  const accountId = file["cf_account_id"] ?? file.accountId;
  if (!apiToken) {
    return {
      error:
        "cf_api_token missing in ~/.pi/agent/cloudflare-browser-run.json — " +
        "create a token with Browser Rendering:Edit permission",
    };
  }
  if (!accountId) {
    return {
      error:
        "cf_account_id missing in ~/.pi/agent/cloudflare-browser-run.json — " +
        "your Cloudflare account id",
    };
  }
  return {
    apiToken,
    accountId,
    apiBase: file["cf_api_base"] ?? file.apiBase ?? DEFAULT_API_BASE,
  };
}

export async function browserRunAction(config: BrowserRunConfig, action: Action, rawUrl: string): Promise<ApiResult> {
  try {
    const url = assertSafeUrl(rawUrl);
    const base = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
    const endpoint = `${base}/accounts/${encodeURIComponent(config.accountId)}/browser-rendering/${action}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Browser Run ${action} failed (HTTP ${res.status}): ${body.slice(0, 200)}` };
    }
    if (action === "markdown") {
      return { ok: true, action, content: await res.text() };
    }
    return { ok: true, action, content: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// /crawl — async multi-page scrape (start + status/poll)
// Docs: https://developers.cloudflare.com/browser-rendering/rest-api/crawl-endpoint/
// ---------------------------------------------------------------------------

export type CrawlSource = "all" | "sitemaps" | "links";
export type CrawlFormat = "html" | "markdown" | "json";

export interface CrawlStartParams {
  url: string;
  limit?: number;
  depth?: number;
  formats?: CrawlFormat[];
  render?: boolean;
  source?: CrawlSource;
  includePatterns?: string[];
  excludePatterns?: string[];
  includeExternalLinks?: boolean;
  includeSubdomains?: boolean;
  /** Content Signals purpose declarations. */
  crawlPurposes?: Array<"search" | "ai-input" | "ai-train">;
  contentUse?: "reference" | "full";
}

export interface CrawlStatusQuery {
  jobId: string;
  /** Max records to return (omit for a full page of results). */
  limit?: number;
  cursor?: string | number;
  /** Filter records: queued|completed|disallowed|skipped|errored|cancelled */
  status?: string;
}

export type CrawlJobStatus =
  | "running"
  | "completed"
  | "errored"
  | "cancelled_due_to_timeout"
  | "cancelled_due_to_limits"
  | "cancelled_by_user"
  | string;

export interface CrawlRecord {
  url: string;
  status: string;
  markdown?: string;
  html?: string;
  json?: unknown;
  metadata?: Record<string, unknown>;
}

export interface CrawlJobResult {
  id: string;
  status: CrawlJobStatus;
  browserSecondsUsed?: number;
  total?: number;
  finished?: number;
  records?: CrawlRecord[];
  cursor?: string | number;
}

export type CrawlApiResult =
  | { ok: true; jobId: string; job?: CrawlJobResult }
  | { ok: false; error: string };

const DEFAULT_CRAWL_FORMATS: CrawlFormat[] = ["markdown"];
const CRAWL_POLL_INTERVAL_MS = 5_000;
const CRAWL_POLL_MAX_ATTEMPTS = 60; // 5 min
const SMALL_CRAWL_LIMIT = 20;

function crawlEndpoint(config: BrowserRunConfig, jobId?: string): string {
  const base = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const root = `${base}/accounts/${encodeURIComponent(config.accountId)}/browser-rendering/crawl`;
  return jobId ? `${root}/${encodeURIComponent(jobId)}` : root;
}

function crawlAuthHeaders(config: BrowserRunConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  };
}

async function readCfJson(res: Response): Promise<{ success?: boolean; result?: unknown; errors?: unknown }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as { success?: boolean; result?: unknown; errors?: unknown };
  } catch {
    throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** Start a crawl job; returns the job id immediately. */
export async function crawlStart(config: BrowserRunConfig, params: CrawlStartParams): Promise<CrawlApiResult> {
  try {
    const url = assertSafeUrl(params.url);
    const body: Record<string, unknown> = {
      url,
      formats: params.formats?.length ? params.formats : DEFAULT_CRAWL_FORMATS,
    };
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.depth !== undefined) body.depth = params.depth;
    if (params.render !== undefined) body.render = params.render;
    if (params.source !== undefined) body.source = params.source;
    if (params.crawlPurposes !== undefined) body.crawlPurposes = params.crawlPurposes;
    if (params.contentUse !== undefined) body.contentUse = params.contentUse;
    const options: Record<string, unknown> = {};
    if (params.includePatterns?.length) options.includePatterns = params.includePatterns;
    if (params.excludePatterns?.length) options.excludePatterns = params.excludePatterns;
    if (params.includeExternalLinks !== undefined) options.includeExternalLinks = params.includeExternalLinks;
    if (params.includeSubdomains !== undefined) options.includeSubdomains = params.includeSubdomains;
    if (Object.keys(options).length) body.options = options;

    const res = await fetch(crawlEndpoint(config), {
      method: "POST",
      headers: crawlAuthHeaders(config),
      body: JSON.stringify(body),
    });
    const data = await readCfJson(res);
    if (!res.ok || data.success === false) {
      const err = data.errors ? JSON.stringify(data.errors).slice(0, 300) : `HTTP ${res.status}`;
      return { ok: false, error: `crawl start failed: ${err}` };
    }
    const jobId = typeof data.result === "string" ? data.result : (data.result as { id?: string } | undefined)?.id;
    if (!jobId) return { ok: false, error: "crawl start failed: missing job id in response" };
    return { ok: true, jobId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetch crawl job status / records. */
export async function crawlStatus(config: BrowserRunConfig, query: CrawlStatusQuery): Promise<CrawlApiResult> {
  try {
    if (!query.jobId || !String(query.jobId).trim()) {
      return { ok: false, error: "jobId is required" };
    }
    const u = new URL(crawlEndpoint(config, query.jobId));
    if (query.limit !== undefined) u.searchParams.set("limit", String(query.limit));
    if (query.cursor !== undefined) u.searchParams.set("cursor", String(query.cursor));
    if (query.status !== undefined) u.searchParams.set("status", String(query.status));

    const res = await fetch(u.toString(), {
      method: "GET",
      headers: crawlAuthHeaders(config),
    });
    const data = await readCfJson(res);
    if (!res.ok || data.success === false) {
      const err = data.errors ? JSON.stringify(data.errors).slice(0, 300) : `HTTP ${res.status}`;
      return { ok: false, error: `crawl status failed: ${err}` };
    }
    const job = data.result as CrawlJobResult;
    const jobId = job?.id ?? query.jobId;
    return { ok: true, jobId, job };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start a crawl and optionally poll until a terminal status.
 * `wait` defaults to true when limit is undefined or ≤20, else false.
 */
export async function crawl(
  config: BrowserRunConfig,
  params: CrawlStartParams & { wait?: boolean },
): Promise<CrawlApiResult> {
  const limit = params.limit ?? 10;
  const wait = params.wait ?? limit <= SMALL_CRAWL_LIMIT;
  const started = await crawlStart(config, params);
  if (!started.ok) return started;
  if (!wait) return started;

  for (let i = 0; i < CRAWL_POLL_MAX_ATTEMPTS; i++) {
    const light = await crawlStatus(config, { jobId: started.jobId, limit: 1 });
    if (!light.ok) return light;
    const status = light.job?.status;
    if (status && status !== "running") {
      return crawlStatus(config, { jobId: started.jobId });
    }
    await sleep(CRAWL_POLL_INTERVAL_MS);
  }
  return {
    ok: false,
    error: `crawl job ${started.jobId} did not complete within timeout (still running)`,
  };
}

/** Whether wait should default on for a given limit (exported for tests). */
export function defaultCrawlWait(limit?: number): boolean {
  return (limit ?? 10) <= SMALL_CRAWL_LIMIT;
}
