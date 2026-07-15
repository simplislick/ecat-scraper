# eCAT Material Scraper

Two-part workflow, no metered API key required:

1. **scrape.js** (this script) -- Playwright discovers ~100 product URLs on a
   supplier site and saves each page's raw text + main thumbnail. Free, runs
   entirely on your machine, no AI involved.
2. **Claude Code** -- reads the raw pages and structures them into the eCAT
   Material Library fields, using your existing Pro/Max subscription instead
   of a pay-per-token API key.

## One-time setup

1. Unzip this folder, e.g. `C:\Users\samuel.lim\ecat-scraper`
2. Open a terminal **inside that folder**:
   ```
   cd C:\Users\samuel.lim\ecat-scraper
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Install the Playwright browser binary (one-time, ~300MB):
   ```
   npx playwright install chromium
   ```

That's it -- no API key, no .env file needed for this part.

## Step 1: Run the scraper

```
node scrape.js https://www.pepperwall.net
```

Optional flags:
```
node scrape.js https://www.pepperwall.net --limit 50
node scrape.js https://www.pepperwall.net --limit 100 --category carpet
```

Output:
```
output/
  pepperwall.net/
    pepperwall.net-raw-pages.json   <- raw text + image links, one per product
    images/                          <- downloaded thumbnails
```

Try `--limit 5` first to sanity-check discovery is finding real product pages
before committing to a full run.

## Step 2: Extract structured fields with Claude Code

Make sure Claude Code is logged in with your Pro/Max subscription, not an API
key:
```
claude logout
claude login
```
(log in with your claude.ai credentials only -- don't add Console credentials,
and make sure no ANTHROPIC_API_KEY environment variable is set on your
machine, or Claude Code will silently bill that instead of using your plan)

Then, from inside the `ecat-scraper` folder, start Claude Code:
```
claude
```

And give it a prompt like:

> Read output/pepperwall.net/pepperwall.net-raw-pages.json and schema.js.
> For each record, extract the fields listed in schema.js's scrapeableFields
> from the rawText, returning null for anything not present -- don't guess.
> Add all of schema.js's manualOnlyFields as explicit nulls too. Write the
> result as output/pepperwall.net/pepperwall.net-materials.json, an array
> matching the same order as the input.

Claude Code will process the batch using your subscription's included usage
(shown in `/status`), not a metered API bill. For very large batches (dozens
of sites x 100 items) it may take a few passes -- if you hit a usage-window
limit, it'll tell you when it resets.

## Step 3: Import into eCAT

Once `pepperwall.net-materials.json` looks right, ask Claude Code (same
session or a new one, in your actual eCAT repo) to:

> Import these records into the materials table via Supabase, uploading the
> thumbnails in images/ to Vercel Blob first and storing the resulting URLs.
> Match field names to the existing schema and set procurementStatus to
> 'draft' for review.

## Before running against a new site

Check `<site>/robots.txt` and terms of service for scraping restrictions --
some suppliers explicitly disallow it. This script doesn't check that for you.

## If discovery finds 0 URLs

Some sites don't have a sitemap and the crawler fallback can't follow their
structure (e.g. JS-driven infinite scroll, login-gated catalogs). Share the
site's category/listing page structure and we can add a custom discovery path.
