// scrape.js
// Usage: node scrape.js <baseUrl> [--limit 100] [--category carpet] [--tag "Premium"]
//
// Example: node scrape.js https://www.pepperwall.net --limit 100
//
// --tag labels every output record with a `category` field and writes to a
// tag-specific output file (output/<domain>/<tag-slug>-raw-pages.json)
// instead of the default <domain>-raw-pages.json. Use this when a supplier
// splits their catalog across several category URLs (e.g. one URL per
// product line) -- run scrape.js once per URL with a different --tag, then
// combine the results (the web UI's batch mode does this automatically).
//
// This script does the FREE, no-API-key part only:
//   1. DISCOVER  - find product page URLs via sitemap.xml, fall back to crawling
//   2. SCRAPE    - load each product page, save its raw text + main image
//   3. OUTPUT    - one raw-pages.json file, ready for Claude Code to read and
//                  extract structured fields (uses your Pro/Max subscription,
//                  not a metered API key)
//
// Uses puppeteer-extra + the stealth plugin, since some supplier sites block
// or serve blank content to plain headless browsers.
//
// No Anthropic API key needed to run this script.

const fs = require("fs");
const path = require("path");
const { launchBrowser } = require("./lib/browser");

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
const tagFlagIndex = args.indexOf("--tag");
const tag = tagFlagIndex !== -1 ? args[tagFlagIndex + 1] : null;

function slugifyTag(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const domain = new URL(baseUrl).hostname.replace(/^www\./, "");
const outputDir = path.join(__dirname, "output", domain);
const imagesDir = path.join(outputDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });
const outFile = tag
  ? path.join(outputDir, `${slugifyTag(tag)}-raw-pages.json`)
  : path.join(outputDir, `${domain}-raw-pages.json`);

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

// Catalog sites often expose brand/style/color-filtered LISTING pages
// under the same "/products/" path as real products (e.g.
// archiproducts.com's /en/products/sofas/brand_mantellassi-1926, plus its
// pagination at .../brand_mantellassi-1926/2 and combined-filter variants
// like .../brand_mantellassi-1926_5a-design). None of the sites we target
// actually name a real product starting with one of these filter words, so
// any URL with such a segment anywhere in its path is excluded outright --
// otherwise these listing pages get scraped as if they were one product,
// and their image gallery ends up being a grab-bag of every other
// product's thumbnail shown in that listing.
const NON_PRODUCT_SEGMENT_PREFIXES = ["brand", "style", "collection", "color", "colour", "material", "finish", "category", "sort"];

function hasListingFilterSegment(url) {
  let segments;
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return false;
  }
  return segments.some((seg) => {
    const lower = seg.toLowerCase();
    return NON_PRODUCT_SEGMENT_PREFIXES.some((p) => lower.startsWith(`${p}_`) || lower.startsWith(`${p}-`));
  });
}

function looksLikeProductUrl(url) {
  const lower = url.toLowerCase();
  const hasHint = PRODUCT_URL_HINTS.some((h) => lower.includes(`/${h}/`) || lower.includes(`/${h}s/`));
  const notCategoryIndex = !lower.endsWith("/products/") && !lower.endsWith("/shop/") && !lower.endsWith("/collections/");
  const matchesCategory = categoryFilter ? lower.includes(categoryFilter) : true;
  return hasHint && notCategoryIndex && matchesCategory && !hasListingFilterSegment(url);
}

// Many catalog sites tack a numeric product id onto the last path segment
// of a real product-detail URL (e.g. archiproducts.com's
// /en/products/edra/sofa-anywhere_784567), while their taxonomy/category
// pages (e.g. /en/products/sofas) don't. looksLikeProductUrl's "/products/"
// hint alone can't tell these apart, so when both kinds of URL turn up in
// the same crawl, prefer the ones with an id suffix -- category pages all
// share one representative thumbnail, which is what caused duplicate
// images across "different" scraped products.
//
// Brand names that embed a founding year (brand_mantellassi-1926,
// brand_riva-1920) look exactly like an id suffix, but those are already
// filtered out by looksLikeProductUrl above; real ids we've seen run to
// 5-6 digits while years are always 4, so require 5+ digits as a second
// line of defense against the same kind of false positive elsewhere.
function hasNumericIdSuffix(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
  return /[-_]\d{5,}$/.test(lastSegment) || /^\d{5,}$/.test(lastSegment);
}

const NON_PRODUCT_HINTS = [
  "/blog/", "/blogs/", "/news/", "/about", "/contact", "/cart", "/checkout",
  "/account", "/login", "/register", "/policy", "/policies", "/terms",
  "/privacy", "/faq", "/pages/", "/page/", "/search", "/wishlist",
  "/careers", "/press", "/sitemap", ".xml", ".pdf", "/tag/", "/tags/",
  "#", "?",
];

function looksLikeProductUrlLoose(url) {
  const lower = url.toLowerCase();
  const isExcluded = NON_PRODUCT_HINTS.some((h) => lower.includes(h));
  if (isExcluded) return false;
  if (hasListingFilterSegment(url)) return false;
  const matchesCategory = categoryFilter ? lower.includes(categoryFilter) : true;
  if (!matchesCategory) return false;
  // heuristic: URL has at least one meaningful path segment beyond the domain,
  // and that segment isn't just the homepage
  const pathSegments = new URL(url).pathname.split("/").filter(Boolean);
  return pathSegments.length >= 1;
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
    console.log(`  ${urls.length} <loc> entries in this file.`);

    // If this is a sitemap INDEX (points to other sitemaps), fetch those too
    const subSitemaps = urls.filter((u) => u.includes("sitemap"));
    if (subSitemaps.length > 0) {
      console.log(`  This looks like a sitemap index. Sub-sitemaps found: ${subSitemaps.length}`);
      subSitemaps.slice(0, 10).forEach((u) => console.log(`    - ${u}`));
      let allUrls = [];
      for (const sub of subSitemaps.slice(0, 10)) {
        const subXml = await tryFetchText(sub);
        if (subXml) {
          const subUrls = extractUrlsFromSitemapXml(subXml);
          console.log(`    fetched ${sub} -> ${subUrls.length} URLs`);
          allUrls.push(...subUrls);
        }
        if (allUrls.length >= limit * 3) break; // gather a buffer before filtering
      }
      urls = allUrls;
    }

    console.log(`  Sample URLs from this sitemap (first 15):`);
    urls.slice(0, 15).forEach((u) => console.log(`    - ${u}`));

    let productUrls = urls.filter(looksLikeProductUrl);
    console.log(`  ${productUrls.length} matched the strict product-URL heuristic.`);

    if (productUrls.length === 0 && urls.length > 0) {
      console.log(`  Trying a looser heuristic (excluding obvious non-product pages)...`);
      productUrls = urls.filter(looksLikeProductUrlLoose);
      console.log(`  ${productUrls.length} matched the loose heuristic.`);
    }

    if (productUrls.length > 0) {
      const withId = productUrls.filter(hasNumericIdSuffix);
      if (withId.length > 0) {
        console.log(`  ${withId.length} of those also carry a numeric product-id suffix -- preferring those.`);
      }
      return [...new Set(withId.length > 0 ? withId : productUrls)];
    }
  }
  return [];
}

// Sort/pagination query strings and stray "#" anchors (e.g. the same
// listing page reached as both "?o=manufacturer" and "?o=popularity")
// point at the same page, not different products -- strip them so they
// collapse to one candidate instead of being counted as separate finds.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    let pathname = u.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return u.origin + pathname;
  } catch {
    return url;
  }
}

async function discoverViaCrawl(browser) {
  console.log("No usable sitemap found, falling back to crawling...");
  const page = await browser.newPage();
  const foundStrict = new Set();
  const foundStrictWithId = new Set();
  const foundLoose = new Set();
  const toVisit = [normalizeUrl(baseUrl)];
  const visited = new Set();
  const baseOrigin = new URL(baseUrl).origin;

  while (toVisit.length > 0 && foundStrict.size < limit * 2 && visited.size < 40) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    console.log(`  crawling: ${url}`);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await sleep(500);
      const rawLinks = await page.$$eval("a[href]", (as) => as.map((a) => a.href));
      console.log(`    found ${rawLinks.length} links on this page`);
      for (const rawLink of rawLinks) {
        // Match same-origin, not same-path-prefix: when the scrape target
        // is a deep category/listing page (e.g. the web UI's "discover
        // from a hub page" flow queuing a category link directly), real
        // product pages usually live under a *different* path on the same
        // site (e.g. /en/products/<brand>/<product>_<id> vs. the category
        // at /en/products/<category>/brand_<brand>) -- a startsWith(baseUrl)
        // check would exclude all of them and leave nothing but variants
        // of the same starting page to "discover".
        let linkOrigin;
        try {
          linkOrigin = new URL(rawLink).origin;
        } catch {
          continue;
        }
        if (linkOrigin !== baseOrigin) continue;
        const link = normalizeUrl(rawLink);
        if (looksLikeProductUrl(link)) {
          foundStrict.add(link);
          if (hasNumericIdSuffix(link)) foundStrictWithId.add(link);
        } else if (looksLikeProductUrlLoose(link)) foundLoose.add(link);
        // Brand/style/color filter pages link to themselves combined with
        // every other filter value (e.g. one brand's page links out to
        // "that brand + every other brand" -- hundreds of near-duplicate
        // combinations). Queuing those for further crawling burns the
        // whole crawl budget on that combinatorial explosion and never
        // reaches an actual product page, so don't follow them.
        if (!visited.has(link) && toVisit.length < 60 && !hasListingFilterSegment(link)) toVisit.push(link);
      }
    } catch (e) {
      console.log(`    (skipped: ${e.message})`);
    }
  }

  await page.close();

  if (foundStrictWithId.size > 0) {
    console.log(
      `  ${foundStrictWithId.size} of ${foundStrict.size} strict matches carry a numeric product-id suffix -- preferring those (the rest are likely category/taxonomy pages).`
    );
    return [...foundStrictWithId];
  }
  if (foundStrict.size > 0) return [...foundStrict];
  console.log(`  No strict matches while crawling. ${foundLoose.size} loose matches found instead.`);
  if (foundLoose.size > 0) {
    console.log(`  Sample loose matches:`);
    [...foundLoose].slice(0, 15).forEach((u) => console.log(`    - ${u}`));
  }
  return [...foundLoose];
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

const MAX_IMAGES_PER_PRODUCT = 20;

// Product pages commonly render their photo gallery as a lazy-loading
// carousel: the visible <img src> is a small placeholder (or a data: URI)
// until the slide scrolls into view, with the real full-resolution URL
// sitting in a data-* attribute instead. og:image / the first <img> tag --
// what this used to rely on -- only ever gives you that one small preview
// image, never the rest of the gallery.
async function extractGalleryImageUrls(page) {
  return page.evaluate(() => {
    const urls = new Set();
    const addIfValid = (u) => {
      if (!u) return;
      u = u.trim();
      if (!u || u.startsWith("data:")) return;
      urls.add(u);
    };

    document.querySelectorAll("img[data-src-big]").forEach((img) => addIfValid(img.getAttribute("data-src-big")));
    document
      .querySelectorAll("img[data-flickity-lazyload-src]")
      .forEach((img) => addIfValid(img.getAttribute("data-flickity-lazyload-src")));
    document
      .querySelectorAll("img[data-large], img[data-zoom-image], img[data-full]")
      .forEach((img) =>
        addIfValid(img.getAttribute("data-large") || img.getAttribute("data-zoom-image") || img.getAttribute("data-full"))
      );

    if (urls.size === 0) {
      // No known gallery markup -- fall back to whatever <img> tags are
      // actually rendered, skipping obvious chrome (logos, icons, ads).
      const skip = /logo|icon|sprite|dropdown|sparkle|placeholder|avatar|banner/i;
      document.querySelectorAll("img[src]").forEach((img) => {
        if (skip.test(img.src)) return;
        addIfValid(img.src);
      });
    }

    if (urls.size === 0) {
      const og = document.querySelector('meta[property="og:image"]');
      if (og) addIfValid(og.content);
    }

    return [...urls];
  });
}

// ---------- Main ----------

async function main() {
  console.log(`\nScraping ${baseUrl} (target: ${limit} items)`);
  console.log("Note: check this site's robots.txt and terms of service before running at scale.\n");

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    console.log(err.message);
    process.exit(1);
  }

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
      await sleep(500);

      const pageText = await page.evaluate(() => document.body.innerText);
      const galleryImageUrls = (await extractGalleryImageUrls(page)).slice(0, MAX_IMAGES_PER_PRODUCT);

      const slug = slugify(url);

      const downloadedImages = [];
      for (let g = 0; g < galleryImageUrls.length; g++) {
        const srcUrl = galleryImageUrls[g];
        const localPath = await downloadImage(srcUrl, `${slug}-${g + 1}`);
        if (localPath) downloadedImages.push({ sourceUrl: srcUrl, localPath });
      }

      const record = {
        sourceUrl: url,
        category: tag || null,
        rawText: pageText.slice(0, 15000), // trimmed to keep the file manageable
        thumbnailImage: downloadedImages[0]?.localPath || null,
        thumbnailSourceUrl: downloadedImages[0]?.sourceUrl || null,
        images: downloadedImages.map((d) => d.localPath),
        imageSourceUrls: downloadedImages.map((d) => d.sourceUrl),
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

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

  console.log(`\nDone. ${results.length} raw pages written to:\n${outFile}`);
  console.log(`Images saved to:\n${imagesDir}`);
  console.log(`\nNext: open Claude Code in this folder and ask it to extract`);
  console.log(`structured fields from ${path.basename(outFile)} using schema.js`);
  console.log(`as the field spec -- see README.md for the exact prompt to use.`);
}

main();
