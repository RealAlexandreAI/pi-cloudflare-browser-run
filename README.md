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

Export these in your shell (or your `~/.zshrc` / `~/.config/fish/config.fish`):

```bash
export CLOUDFLARE_API_TOKEN="<token with Browser Rendering:Edit permission>"
export CLOUDFLARE_ACCOUNT_ID="<your Cloudflare account id>"
```

- Token: Cloudflare Dashboard → My Profile → API Tokens → Create Token →
  **Browser Rendering: Edit** (or a custom token with the same permission).
- Account id: dashboard URL `dash.cloudflare.com/<ACCOUNT_ID>/...`.

Optional: `CF_API_BASE` (default `https://api.cloudflare.com/client/v4`).

If either variable is missing the tools reply with a setup hint instead of
erroring.

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

## Config file (optional)

Instead of env vars you can create `~/.pi/agent/cloudflare-browser-run.json`:

```json
{
  "apiToken": "...",
  "accountId": "..."
}
```

Env vars win when both are present.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
