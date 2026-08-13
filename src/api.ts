// Cloudflare Browser Run REST client.
// Quick Actions are one-shot HTTP calls: headless Chrome on CF's network
// renders the URL and returns markdown / PNG / PDF. No Workers needed —
// a scoped API token is enough.
//
// Endpoints (v4 API):
//   POST /accounts/{ACCOUNT_ID}/browser-rendering/{screenshot|markdown|pdf}
//
// Security: URL strictness first — only public http(s), localhost / private
// / reserved IPs / IPv6 literals / userinfo are rejected (SSRF guard).

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

/** Merge env vars with an optional ~/.pi/agent/cloudflare-browser-run.json
 *  config file. Env wins. Returns a config or a setup-hint error. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrowserRunConfig | { error: string } {
  let file: Partial<BrowserRunConfig> = {};
  try {
    const { readFileSync } = require("fs") as typeof import("fs");
    const { homedir } = require("os") as typeof import("os");
    const { join } = require("path") as typeof import("path");
    const p = join(homedir(), ".pi", "agent", "cloudflare-browser-run.json");
    file = JSON.parse(readFileSync(p, "utf8")) as Partial<BrowserRunConfig>;
  } catch {
    // no config file — env only
  }
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN ?? file.apiToken;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID ?? file.accountId;
  if (!apiToken) {
    return { error: "CLOUDFLARE_API_TOKEN not set — create a token with Browser Rendering:Edit permission" };
  }
  if (!accountId) return { error: "CLOUDFLARE_ACCOUNT_ID not set (your CF account id)" };
  return { apiToken, accountId, apiBase: env.CF_API_BASE ?? file.apiBase ?? DEFAULT_API_BASE };
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
