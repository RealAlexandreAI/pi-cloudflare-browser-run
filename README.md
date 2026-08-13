# pi-cloudflare-browser-run

Pi extension that gives the model **web browsing tools** backed by
[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) —
headless Chrome on CF's network. Pages render with a real browser, so
JS-heavy/SPA sites work, and the request comes from Cloudflare's network
(not your machine).

No Workers, no proxy: the extension calls Browser Run Quick Actions over
the v4 REST API directly.

## Tools

| tool | what it does |
|---|---|
| `browse` | fetch a public URL, return clean **markdown** text (default; also `screenshot` / `pdf` actions) |
| `screenshot` | save a PNG of the page locally, returns the file path |
| `pdf` | save a PDF of the page locally, returns the file path |

## Install

```bash
pi install npm:pi-cloudflare-browser-run
```

Restart `pi` if it was already running.

## Auth (required)

The tools call Cloudflare Browser Run on your behalf, so they need a Cloudflare
API token with **Browser Rendering: Edit** permission plus your account id.

### 1. Create the token (one time)

1. Open https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → under *Start with a template* pick
   **"Browser Rendering: Edit"** (or *Create Custom Token* and add the
   **Browser Rendering — Edit** permission)
3. Copy the token (shown once) — it starts with a random string
4. Find your account id: dashboard URL is
   `dash.cloudflare.com/<ACCOUNT_ID>/...` (also shown under the account's
   *Overview* or in the Workers dashboard)

### 2. Give the extension the credentials

Pick one:

**Option A — config file (recommended)** — create
`~/.pi/agent/cloudflare-browser-run.json`:

```json
{
  "apiToken": "paste-your-token-here",
  "accountId": "paste-your-account-id"
}
```

**Option B — environment variables** (add to `~/.zshrc` /
`~/.config/fish/config.fish`):

```bash
export CLOUDFLARE_API_TOKEN="paste-your-token-here"
export CLOUDFLARE_ACCOUNT_ID="paste-your-account-id"
```

Env vars win when both are present. Optional: `CF_API_BASE` (default
`https://api.cloudflare.com/client/v4`).

If either value is missing the tools reply with a setup hint instead of
erroring — nothing breaks.

### 3. Verify

```bash
curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-rendering/markdown" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

A `200` with markdown text means the token works.

## Usage

Ask the model to browse something — it will pick the tool itself:

```
> what's on the Cloudflare blog today?
> open https://example.com and summarize it
> screenshot https://news.ycombinator.com
```

Screenshots/PDFs are saved under
`/tmp/pi-cloudflare-browser-run/` (macOS/Linux) and the returned path can
be opened directly.

## Security

- **Public web only**: every URL passes an SSRF guard before the API is
  called — non-http(s) protocols, localhost, private/reserved IPs, IPv6
  literals, userinfo, and oversized URLs are rejected.
- The token is read from the environment at load time; it is never logged
  and never written to disk by this extension.
- Browser Run itself identifies its traffic as a bot (`Well-behaved Bot
  Mode`), which is the compliant way to scrape.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
