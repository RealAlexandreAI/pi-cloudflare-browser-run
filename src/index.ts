// pi-cloudflare-browser-run — Pi extension registering web-browsing tools
// backed by Cloudflare Browser Run Quick Actions.
//
// Tools:
//   browse(url, action?)       read a page as clean markdown (default)
//   screenshot(url)            save a PNG of the page, returns local path
//   pdf(url)                   save a PDF of the page, returns local path
//   crawl(url, ...)            multi-page crawl via /crawl (optional wait/poll)
//   crawl_status(jobId, ...)   poll / fetch crawl job results
//
// Auth: CLOUDFLARE_API_TOKEN (Browser Rendering:Edit) + CLOUDFLARE_ACCOUNT_ID
// env vars. No Workers, no proxy — direct v4 REST calls.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  browserRunAction,
  crawl,
  crawlStatus,
  defaultCrawlWait,
  loadConfig,
  type Action,
  type CrawlFormat,
  type CrawlJobResult,
  type CrawlRecord,
} from "./api.js";

const urlSchema = Type.Object({
  url: Type.String({ minLength: 1, description: "Public http(s) URL, e.g. https://example.com" }),
});
const browseSchema = Type.Object({
  url: Type.String({ minLength: 1, description: "Public http(s) URL, e.g. https://example.com" }),
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("markdown"),
        Type.Literal("screenshot"),
        Type.Literal("pdf"),
      ],
      { description: "What to extract (default markdown)" },
    ),
  ),
});

const ACTION_LABEL: Record<Action, string> = {
  markdown: "markdown text",
  screenshot: "PNG",
  pdf: "PDF",
};

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function saveToTemp(action: Action, data: Uint8Array): string {
  const dir = join(tmpdir(), "pi-cloudflare-browser-run");
  mkdirSync(dir, { recursive: true });
  const ext = action === "screenshot" ? "png" : "pdf";
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  writeFileSync(file, data);
  return file;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerTool({
    name: "browse",
    label: "Browse",
    description:
      "Fetch a public web page in a headless Chrome (Cloudflare Browser Run) " +
      "and return clean markdown text. Use for ANY web access: reading articles, " +
      "checking live sites, extracting text from JS-rendered pages.",
    promptSnippet: "browse a public URL (markdown / screenshot / pdf)",
    promptGuidelines: [
      "Prefer browse over guessing for anything that changed recently or lives on the web.",
      "browse only accepts public http(s) URLs; private/localhost addresses are rejected.",
    ],
    parameters: browseSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const action: Action = (params.action ?? "markdown") as Action;
      const cfg = typeof config === "object" && "apiToken" in config ? config : null;
      if (!cfg) return toolResult(`browse unavailable: ${(config as { error: string }).error}`);
      const r = await browserRunAction(cfg, action, params.url);
      if (!r.ok) return toolResult(`browse failed: ${"error" in r ? r.error : "unknown"}`);
      if (action === "markdown") {
        const text = String(r.content).slice(0, 100_000);
        return toolResult(text || "(page returned no readable text)");
      }
      const file = saveToTemp(action, r.content as Uint8Array);
      return toolResult(`${ACTION_LABEL[action]} saved to ${file}`);
    },
  });

  pi.registerTool({
    name: "screenshot",
    label: "Screenshot",
    description:
      "Take a screenshot of a public web page in headless Chrome (Cloudflare " +
      "Browser Run) and save it locally as PNG. Returns the local file path.",
    promptSnippet: "screenshot a public URL to PNG",
    parameters: urlSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const cfg = typeof config === "object" && "apiToken" in config ? config : null;
      if (!cfg) return toolResult(`screenshot unavailable: ${(config as { error: string }).error}`);
      const r = await browserRunAction(cfg, "screenshot", params.url);
      if (!r.ok) return toolResult(`screenshot failed: ${"error" in r ? r.error : "unknown"}`);
      const file = saveToTemp("screenshot", r.content as Uint8Array);
      return toolResult(`screenshot saved to ${file}`);
    },
  });

  pi.registerTool({
    name: "pdf",
    label: "Save as PDF",
    description:
      "Render a public web page to PDF in headless Chrome (Cloudflare Browser " +
      "Run) and save it locally. Returns the local file path.",
    promptSnippet: "save a public URL as PDF",
    parameters: urlSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const cfg = typeof config === "object" && "apiToken" in config ? config : null;
      if (!cfg) return toolResult(`pdf unavailable: ${(config as { error: string }).error}`);
      const r = await browserRunAction(cfg, "pdf", params.url);
      if (!r.ok) return toolResult(`pdf failed: ${"error" in r ? r.error : "unknown"}`);
      const file = saveToTemp("pdf", r.content as Uint8Array);
      return toolResult(`pdf saved to ${file}`);
    },
  });

  const truncateRecord = (rec: CrawlRecord, maxMd = 4_000): CrawlRecord => {
    const out: CrawlRecord = { url: rec.url, status: rec.status };
    if (rec.metadata) out.metadata = rec.metadata;
    if (typeof rec.markdown === "string") {
      out.markdown =
        rec.markdown.length > maxMd ? rec.markdown.slice(0, maxMd) + "\n…(truncated)" : rec.markdown;
    }
    if (typeof rec.html === "string") {
      out.html = rec.html.length > maxMd ? rec.html.slice(0, maxMd) + "\n…(truncated)" : rec.html;
    }
    if (rec.json !== undefined) out.json = rec.json;
    return out;
  };

  const formatCrawlJob = (job: CrawlJobResult, maxRecords = 50): string => {
    const records = (job.records ?? []).slice(0, maxRecords).map((r) => truncateRecord(r));
    return JSON.stringify(
      {
        id: job.id,
        status: job.status,
        total: job.total,
        finished: job.finished,
        browserSecondsUsed: job.browserSecondsUsed,
        cursor: job.cursor,
        recordCount: records.length,
        records,
      },
      null,
      2,
    );
  };

  const crawlSchema = Type.Object({
    url: Type.String({ minLength: 1, description: "Starting public http(s) URL to crawl" }),
    limit: Type.Optional(Type.Number({ description: "Max pages to crawl (default 10)" })),
    depth: Type.Optional(Type.Number({ description: "Max link depth from the start URL" })),
    formats: Type.Optional(
      Type.Array(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("json")]), {
        description: "Response formats (default [markdown])",
      }),
    ),
    render: Type.Optional(Type.Boolean({ description: "Headless Chrome (true) or fast HTML fetch (false)" })),
    source: Type.Optional(
      Type.Union([Type.Literal("all"), Type.Literal("sitemaps"), Type.Literal("links")], {
        description: "URL discovery source (default all)",
      }),
    ),
    includePatterns: Type.Optional(Type.Array(Type.String(), { description: "Only visit matching URL patterns" })),
    excludePatterns: Type.Optional(Type.Array(Type.String(), { description: "Skip matching URL patterns" })),
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Poll until done (default true when limit≤20). If false, returns job id immediately.",
      }),
    ),
  });

  const crawlStatusSchema = Type.Object({
    jobId: Type.String({ minLength: 1, description: "Crawl job id from crawl" }),
    limit: Type.Optional(Type.Number({ description: "Max records to return" })),
    cursor: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Pagination cursor" })),
    status: Type.Optional(
      Type.String({ description: "Filter records: queued|completed|disallowed|skipped|errored|cancelled" }),
    ),
  });

  pi.registerTool({
    name: "crawl",
    label: "Crawl",
    description:
      "Crawl a public site starting from a URL via Cloudflare Browser Run /crawl. " +
      "Follows links up to limit/depth and returns markdown (default) per page. " +
      "For small jobs (limit≤20) waits for completion by default; for larger jobs " +
      "returns a job id — then use crawl_status.",
    promptSnippet: "crawl a public site (multi-page markdown)",
    promptGuidelines: [
      "Use crawl when you need several pages from one site; use browse for a single URL.",
      "Prefer small limits (≤20) so wait can finish in one call; use crawl_status for long jobs.",
    ],
    parameters: crawlSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const cfg = typeof config === "object" && "apiToken" in config ? config : null;
      if (!cfg) return toolResult(`crawl unavailable: ${(config as { error: string }).error}`);
      const limit = typeof params.limit === "number" ? params.limit : undefined;
      const wait = typeof params.wait === "boolean" ? params.wait : defaultCrawlWait(limit);
      const r = await crawl(cfg, {
        url: params.url,
        limit,
        depth: typeof params.depth === "number" ? params.depth : undefined,
        formats: (params.formats as CrawlFormat[] | undefined) ?? ["markdown"],
        render: typeof params.render === "boolean" ? params.render : undefined,
        source: params.source as "all" | "sitemaps" | "links" | undefined,
        includePatterns: params.includePatterns as string[] | undefined,
        excludePatterns: params.excludePatterns as string[] | undefined,
        wait,
      });
      if (!r.ok) return toolResult(`crawl failed: ${"error" in r ? r.error : "unknown"}`);
      if (r.job) return toolResult(formatCrawlJob(r.job));
      return toolResult(
        JSON.stringify(
          {
            jobId: r.jobId,
            status: "running",
            message: "Crawl started. Poll with crawl_status(jobId) until status is completed.",
          },
          null,
          2,
        ),
      );
    },
  });

  pi.registerTool({
    name: "crawl_status",
    label: "Crawl status",
    description:
      "Check status or fetch results of a Cloudflare Browser Run crawl job by id. " +
      "Supports limit/cursor pagination and status filters on records.",
    promptSnippet: "poll crawl job status / results",
    parameters: crawlStatusSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const cfg = typeof config === "object" && "apiToken" in config ? config : null;
      if (!cfg) return toolResult(`crawl_status unavailable: ${(config as { error: string }).error}`);
      const r = await crawlStatus(cfg, {
        jobId: params.jobId,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        cursor: params.cursor as string | number | undefined,
        status: typeof params.status === "string" ? params.status : undefined,
      });
      if (!r.ok) return toolResult(`crawl_status failed: ${"error" in r ? r.error : "unknown"}`);
      if (r.job) return toolResult(formatCrawlJob(r.job));
      return toolResult(JSON.stringify({ jobId: r.jobId }, null, 2));
    },
  });
}
