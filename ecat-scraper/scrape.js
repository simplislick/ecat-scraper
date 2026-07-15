// scrape.js
// Usage: node scrape.js <baseUrl> [--limit 100] [--category carpet]
//
// Example: node scrape.js https://www.pepperwall.net --limit 100
//
// This script does the FREE, no-API-key part only:
//   1. DISCOVER  - find product page URLs via sitemap.xml, fall back to crawling
//   2. SCRAPE    - load each product page, save its raw text + main image
//   3. OUTPUT    - one raw-pages.json file, ready for Claude Code to read and
//                  extract structured fields (uses your Pro/Max subscription,
//                  not a metered API key)
//
// No Anthropic API key needed to run this script.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- CLI args ----------
const args = process.argv.slice(2);
const baseUrl = args[0];
if (!baseUrl) {
  console.error("Usage: node scrape.js <baseUrl> [--limit 100] [--category carpet]");
  process.exit(1);
}
const limitFlagIndex = args.indexOf("--limit");
const limit = limitFlagIndex !== -1 ? parseInt(args[limitFlagIndex + 1], 10) : 100;
const categoryFlagIndex = args.indexOf("--category");
const categoryFilter = categoryFlagIndex !== -1 ? args[categoryFlagIndex + 1].toLowerCase() : null;

const domain = new URL(baseUrl).hostname.replace(/^www\./, "");
const outputDir = path.join(__dirname, "output", domain);
const imagesDir = path.join(outputDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Step 1: Discovery ----------

async function tryFetchText(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractUrlsFromSitemapXml(xml) {
  const matches = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)];
  return matches.map((m) => m[1].trim());
}

const PRODUCT_URL_HINTS = ["product", "products", "shop", "item", "collection", "material", "catalog"];

function looksLikeProductUrl(url) {
  const lower = url.toLowerCase();
  const hasHint = PRODUCT_URL_HINTS.some((h) => lower.includes(`/${h}/`) || lower.includes(`/${h}s/`));
  const notCategoryIndex = !lower.endsWith("/products/") && !lower.endsWith("/shop/") && !lower.endsWith("/collections/");
  const matchesCategory = categoryFilter ? lower.includes(categoryFilter) : true;
  return hasHint && notCategoryIndex && matchesCategory;
}

async function discoverViaSitemap() {
  const candidates = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/sitemap-products.xml`,
    `${baseUrl}/product-sitemap.xml`,
  ];

  for (const sitemapUrl of candidates) {
    const xml = await tryFetchText(sitemapUrl);
    if (!xml) continue;
    console.log(`Found sitemap: ${sitemapUrl}`);

    let urls = extractUrlsFromSitemapXml(xml);

    // If this is a sitemap INDEX (points to other sitemaps), fetch those too
    const subSitemaps = urls.filter((u) => u.includes("sitemap") && u.endsWith(".xml"));
    if (subSitemaps.length > 0) {
      let allUrls = [];
      for (const sub of subSitemaps.slice(0, 10)) {
        const subXml = await tryFetchText(sub);
        if (subXml) allUrls.push(...extractUrlsFromSitemapXml(subXml));
        if (allUrls.length >= limit * 3) break; // gather a buffer before filtering
      }
      urls = allUrls;
    }

    const productUrls = urls.filter(looksLikeProductUrl);
    if (productUrls.length > 0) return [...new Set(productUrls)];
  }
  return [];
}

async function discoverViaCrawl(browser) {
  console.log("No usable sitemap found, falling back to crawling...");
  const page = await browser.newPage();
  const found = new Set();
  const toVisit = [baseUrl];
  const visited = new Set();

  while (toVisit.length > 0 && found.size < limit * 2 && visited.size < 40) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(500);
      const links = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
      for (const link of links) {
        if (!link.startsWith(baseUrl)) continue;
        if (looksLikeProductUrl(link)) found.add(link);
        else if (!visited.has(link) && toVisit.length < 60) toVisit.push(link);
      }
    } catch (e) {
      console.log(`  (skipped ${url}: ${e.message})`);
    }
  }

  await page.close();
  return [...found];
}

// ---------- Step 2: Images ----------

async function downloadImage(imageUrl, slug) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const ext = path.extname(new URL(imageUrl).pathname).split("?")[0] || ".jpg";
    const filename = `${slug}${ext}`;
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(imagesDir, filename), buffer);
    return `images/${filename}`;
  } catch {
    return null;
  }
}

function slugify(text) {
  return (text || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

// ---------- Main ----------

async function main() {
  console.log(`\nScraping ${baseUrl} (target: ${limit} items)`);
  console.log("Note: check this site's robots.txt and terms of service before running at scale.\n");

  const browser = await chromium.launch();

  let productUrls = await discoverViaSitemap();
  if (productUrls.length === 0) {
    productUrls = await discoverViaCrawl(browser);
  }
  productUrls = productUrls.slice(0, limit);
  console.log(`Discovered ${productUrls.length} candidate product URLs.\n`);

  if (productUrls.length === 0) {
    console.log("No product URLs found. This site may need a custom discovery strategy -- let's adjust the script.");
    await browser.close();
    return;
  }

  const results = [];
  const page = await browser.newPage();

  for (let i = 0; i < productUrls.length; i++) {
    const url = productUrls[i];
    console.log(`[${i + 1}/${productUrls.length}] ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(500);

      const pageText = await page.evaluate(() => document.body.innerText);
      const mainImageUrl = await page.evaluate(() => {
        const og = document.querySelector('meta[property="og:image"]');
        if (og) return og.content;
        const img = document.querySelector("img");
        return img ? img.src : null;
      });

      const slug = slugify(url);

      let localImagePath = null;
      if (mainImageUrl) {
        localImagePath = await downloadImage(mainImageUrl, slug);
      }

      const record = {
        sourceUrl: url,
        rawText: pageText.slice(0, 15000), // trimmed to keep the file manageable
        thumbnailImage: localImagePath,
        thumbnailSourceUrl: mainImageUrl,
      };

      results.push(record);
    } catch (e) {
      console.log(`  (failed: ${e.message})`);
      results.push({ sourceUrl: url, _error: e.message });
    }

    await sleep(800); // be polite to the supplier's server
  }

  await page.close();
  await browser.close();

  const outFile = path.join(outputDir, `${domain}-raw-pages.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  console.log(`\nDone. ${results.length} raw pages written to:\n${outFile}`);
  console.log(`Images saved to:\n${imagesDir}`);
  console.log(`\nNext: open Claude Code in this folder and ask it to extract`);
  console.log(`structured fields from ${path.basename(outFile)} using schema.js`);
  console.log(`as the field spec -- see README.md for the exact prompt to use.`);
}

main();
