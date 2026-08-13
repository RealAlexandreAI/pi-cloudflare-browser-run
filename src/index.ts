// pi-cloudflare-browser-run — Pi extension registering web-browsing tools
// backed by Cloudflare Browser Run Quick Actions.
//
// Tools:
//   browse(url, action?)       read a page as clean markdown (default)
//   screenshot(url)            save a PNG of the page, returns local path
//   pdf(url)                   save a PDF of the page, returns local path
//
// Auth: CLOUDFLARE_API_TOKEN (Browser Rendering:Edit) + CLOUDFLARE_ACCOUNT_ID
// env vars. No Workers, no proxy — direct v4 REST calls.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { browserRunAction, loadConfig, type Action } from "./api.js";

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
}
