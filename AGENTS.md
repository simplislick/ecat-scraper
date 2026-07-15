# AGENTS.md — eCAT Material Scraper

This file is a guide for AI coding agents working on the `ecat-scraper` project. It describes the project's purpose, architecture, runtime commands, conventions, and things you should know before making changes.

## Project overview

`ecat-scraper` is a local desktop tool for collecting material/product data from supplier websites. It is the first step in a two-step workflow:

1. **Scrape** — this project discovers product pages on a supplier site, downloads each page's raw text and main images, and writes them to `output/<domain>/<domain>-raw-pages.json`.
2. **Structure** — a human uses Claude Code to read the raw JSON and `schema.js`, then extracts structured eCAT Material Library fields. This second step is intentionally manual (it uses a Pro/Max subscription rather than a metered API key).

The project has no cloud dependency, no database, and no API key needed for scraping.

## Technology stack

- **Runtime:** Node.js
- **Scraping:** Puppeteer 23.x with `puppeteer-extra` and `puppeteer-extra-plugin-stealth`
- **Server API:** Express 4.x with `cors`
- **Web UI:** React 18 + Vite 5
- **Process runner:** `concurrently` (for `npm run dev`)
- **Module systems:**
  - Root project: CommonJS (`"type": "commonjs"`)
  - `web/`: ES Modules (`"type": "module"`)

There is no TypeScript, no test framework, no linter, and no CI/CD configuration in this repository.

## Directory structure

```
d:\_personal\ecat-scraper\
├── package.json              # Root Node project (CommonJS)
├── package-lock.json
├── README.md                 # Human-facing user guide
├── AGENTS.md                 # This file
├── schema.js                 # eCAT field definitions
├── scrape.js                 # CLI scraper entry point
├── lib/
│   ├── browser.js            # Shared Puppeteer launcher + Chrome/Edge fallback
│   └── discover.js           # Hub-page category link discovery
├── server/
│   └── index.js              # Express API + SSE progress streaming
├── output/                   # Generated scrape artifacts
│   ├── heartglobal.net/
│   └── pepperwall.net/
└── web/                      # Vite + React UI
    ├── package.json
    ├── package-lock.json
    ├── vite.config.js
    ├── index.html
    ├── dist/                 # Pre-built production bundle
    └── src/
        ├── App.jsx
        ├── main.jsx
        └── index.css
```

There is also a nested folder `ecat-scraper/ecat-scraper/` that is a legacy copy of an earlier Playwright-only CLI version. The active/current code lives at the repository root. Do not edit the nested copy unless explicitly asked.

## Architecture

### `scrape.js` — CLI scraper

Entry point for command-line scraping. It accepts:

```bash
node scrape.js <baseUrl> [--limit 100] [--category carpet] [--tag "Premium"]
```

Behavior:
- `--limit` defaults to `100`, maximum used by the UI is `500`.
- `--category` filters discovered URLs by a substring match on the URL.
- `--tag` labels every record with a `category` field and writes output to `output/<domain>/<tag-slug>-raw-pages.json` instead of the default `<domain>-raw-pages.json`. Use this when a supplier splits its catalog across several category URLs.

Discovery pipeline:
1. Try sitemap discovery at `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-products.xml`, `/product-sitemap.xml`.
2. If a sitemap index is found, follow up to 10 sub-sitemaps.
3. Apply strict product-URL heuristics (hints like `/product/`, `/shop/`, `/collection/`, etc.).
4. Exclude listing/filter segments such as `brand_`, `style_`, `color_`, `collection_`, etc.
5. Prefer URLs with a numeric ID suffix of 5+ digits.
6. If sitemaps yield nothing, fall back to same-origin crawling (up to 40 visited pages, 60 queued).

Scraping pipeline:
- Loads each product page with Puppeteer.
- Extracts `document.body.innerText` trimmed to 15,000 characters.
- Extracts gallery images via lazy-load data attributes (`data-src-big`, `data-flickity-lazyload-src`, `data-large`, `data-zoom-image`, `data-full`), falling back to `<img src>` or `og:image`.
- Downloads up to 20 images per product to `output/<domain>/images/`.
- Writes one JSON file per run with records containing `sourceUrl`, `category`, `rawText`, `thumbnailImage`, `thumbnailSourceUrl`, `images`, `imageSourceUrls`.
- Politeness delays: 500 ms after page load, 800 ms between requests.

### `lib/browser.js`

Shared Puppeteer launcher used by both `scrape.js` and `server/index.js`:
- Applies the stealth plugin.
- First tries bundled Chromium.
- Falls back to system Chrome/Edge on Windows, macOS, or Linux.
- Supports `CHROME_PATH` environment variable override.

### `lib/discover.js`

Given a hub/landing page URL, extracts same-origin candidate category links:
- Excludes blogs, contact, cart, login, policies, mailto/tel, etc.
- Returns up to 40 `{url, label}` candidates.
- Used by the web UI's "Discover categories from a hub page" feature.

### `server/index.js`

Express server that wraps `scrape.js` for the web UI.

Environment:
- `PORT` defaults to `3001`.
- State is in-memory only (`batches` Map).

Endpoints:
- `POST /api/scrape-batch` — queue one or more scrape jobs.
- `GET /api/scrape-batch/:batchId/events` — SSE stream of logs/progress.
- `POST /api/discover` — hub-page category discovery.
- `GET /api/outputs` — list previous scrape outputs with counts and mtimes.
- `GET /api/download/:domain` — download merged `<domain>-raw-pages.json`.
- `POST /api/open-folder/:domain` — open output folder in the OS file explorer.

Important implementation notes:
- The server spawns `scrape.js` as a child process per job and streams stdout/stderr via SSE.
- When a batch contains multiple tagged jobs for the same domain, the server merges every `*-raw-pages.json` file into the single `<domain>-raw-pages.json`, deduping by `sourceUrl`.
- `/api/open-folder/:domain` invokes `explorer.exe`, `open`, or `xdg-open`. This endpoint only makes sense on localhost and should never be exposed publicly.

### `web/src/App.jsx`

Single-page React app that provides:
- A URL queue with optional category tags per row.
- Limit setting (1–500).
- Hub-page category discovery mode.
- Live job status sidebar.
- Terminal-style log viewer.
- History of previous scrapes with download and "Open Output Folder" actions.

`vite.config.js` proxies `/api` to `http://localhost:3001` during development.

### `schema.js`

Exports two objects:
- `scrapeableFields` — 27 fields the scraper expects Claude to extract from raw text (product name, category, dimensions, material composition, fire rating, etc.).
- `manualOnlyFields` — 13 fields left as explicit `null`s because they rarely exist on public supplier pages (supplier company name, manufacturer, contact info, pricing, warranty, lead time, procurement status, etc.).

This file is the field spec for the manual Claude Code extraction step. It is not used by `scrape.js` at runtime.

## Build and run commands

### One-time setup

```bash
npm install
```

Puppeteer bundles its own Chromium, so no separate browser install is required unless the bundled binary is missing or blocked.

### CLI scraper

```bash
node scrape.js https://www.pepperwall.net
node scrape.js https://www.pepperwall.net --limit 50
node scrape.js https://www.pepperwall.net --limit 100 --category carpet
node scrape.js https://www.heartglobal.net/acoustic-wall-panels/premium --tag Premium
```

### Server only

```bash
npm run server      # http://localhost:3001
```

### Web UI only

```bash
npm run web         # http://localhost:5173
```

### Full dev stack

```bash
npm run dev         # runs server + web UI concurrently
```

### Build the web UI for production

```bash
cd web
npm run build       # outputs to web/dist/
npm run preview
```

## Code style and conventions

- **No linter or formatter is configured.** Follow the existing style.
- Mixed module systems: root is CommonJS (`require`/`module.exports`); `web/` is ES Modules (`import`/`export`).
- Variable and function names use `camelCase`.
- Comments above functions explain the "why" behind heuristics (e.g. why numeric-ID suffixes are preferred, why filter segments are excluded).
- The project keeps dependencies minimal; prefer built-in Node.js APIs where possible.

## Testing

There are no automated tests in this project. Validation is manual:
- Run with `--limit 5` against a new site to sanity-check URL discovery before a full run.
- Inspect `output/<domain>/<domain>-raw-pages.json` and the `images/` folder.
- Check the web UI terminal log for errors.

## Security considerations

- **Local-only tool.** The `/api/open-folder/:domain` endpoint executes OS file-explorer commands. The server is intended to run on the user's own machine only.
- **No authentication.** Do not expose the Express server to a network.
- **Respect robots.txt and terms of service.** The scraper does not check `robots.txt` automatically; verify scraping is allowed before running at scale.
- **No API key or secrets file.** Scraping does not require credentials. The Claude Code extraction step uses the user's existing Claude subscription, not an Anthropic API key.

## Important caveats for agents

- The root project uses **Puppeteer**, not Playwright. The nested `ecat-scraper/ecat-scraper/` folder is the old Playwright version. The root `README.md` still mentions Playwright in its opening paragraph; that is stale wording.
- The structured extraction step is **not implemented in code**. It is performed by prompting Claude Code with the raw JSON and `schema.js`. Do not add an automated extraction pipeline unless the user explicitly asks for it.
- Discovery can fail on JavaScript-driven infinite scroll, login-gated catalogs, or sites without sitemaps. In those cases the right fix is usually a custom discovery path in `scrape.js`, not a generic change.
- `output/` contains real scraped data. Treat it as user data and do not delete or modify it unless requested.

## Deployment

This project is not configured for deployment. There is no `vercel.json`, Docker, GitHub Actions, or cloud build config. It is designed to run locally on the developer's machine.
