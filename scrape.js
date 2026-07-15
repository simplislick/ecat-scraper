// scrape.js
// Usage: node scrape.js <baseUrl> [--limit 100] [--category carpet] [--tag "Premium"]
//
// Example: node scrape.js https://www.pepperwall.net --limit 100
//
// --tag labels every output record with a `category` field and writes to a
// tag-specific output file (output/<domain>/<tag-slug>/<tag-slug>-raw-pages.json)
// instead of the default output/<domain>/uncategorized/<domain>-raw-pages.json.
// Use this when a supplier splits their catalog across several category URLs
// (e.g. one URL per product line) -- run scrape.js once per URL with a
// different --tag, then combine the results (the web UI's batch mode does
// this automatically into output/<domain>/<domain>-raw-pages.json).
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
// The domain folder (output/<domain>) is the brand-level folder; each
// category tag gets its own subfolder underneath -- both the raw-pages JSON
// and the images for that category live inside it -- so different
// categories on the same site never share a folder. The server's batch
// merge step (mergeDomainOutputs) later combines every category subfolder's
// JSON into one output/<domain>/<domain>-raw-pages.json for export.
const categorySlug = tag ? slugifyTag(tag) : "uncategorized";
const categoryDir = path.join(outputDir, categorySlug);
const imagesDir = path.join(categoryDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });
const outFile = path.join(categoryDir, `${categorySlug}-raw-pages.json`);

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

// A hub/category page is always shallower in the URL path than the
// individual product pages it links to, on any site -- so a same-depth
// same-origin link found on (or discovered alongside) the hub page is a
// sibling listing/taxonomy page, not one of its products, while a deeper
// link is plausibly a real product. This is used instead of a hardcoded
// per-site keyword list (e.g. matching "brand_"/"style_" segments) so the
// same logic works generically across different suppliers' URL schemes.
const baseUrlDepth = new URL(baseUrl).pathname.split("/").filter(Boolean).length;

function isDeeperThanHub(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length > baseUrlDepth;
  } catch {
    return false;
  }
}

function looksLikeProductUrl(url) {
  const lower = url.toLowerCase();
  const hasHint = PRODUCT_URL_HINTS.some((h) => lower.includes(`/${h}/`) || lower.includes(`/${h}s/`));
  const notCategoryIndex = !lower.endsWith("/products/") && !lower.endsWith("/shop/") && !lower.endsWith("/collections/");
  const matchesCategory = categoryFilter ? lower.includes(categoryFilter) : true;
  return hasHint && notCategoryIndex && matchesCategory && isDeeperThanHub(url);
}

// Many catalog sites tack a numeric product id onto the last path segment
// of a real product-detail URL, while their taxonomy/category pages don't.
// looksLikeProductUrl's hint + depth checks alone can't always tell these
// apart, so when both kinds of URL turn up in the same crawl, prefer the
// ones with an id suffix -- category pages all share one representative
// thumbnail, which is what caused duplicate images across "different"
// scraped products. Ids we've seen run to 5-6 digits; require 5+ digits so
// a 4-digit founding year embedded in a name (e.g. "-1926") isn't mistaken
// for one.
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
  if (!isDeeperThanHub(url)) return false;
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
      } else {
        console.log(
          `  WARNING: none of the ${productUrls.length} matched URL(s) carry a numeric product-id suffix -- there's no strong signal telling real products apart from other listing pages here, so results may include pages that don't actually belong to this category. Spot-check the output before trusting it.`
        );
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
      // Sitewide chrome (nav bars, footers, "recommended"/"best sellers"
      // widgets in a sidebar) tends to repeat the *same* links on every
      // page of a site, including every different category's hub page --
      // counting those as this category's own products is how unrelated
      // items (e.g. a sitewide bestseller) end up attributed to every
      // category instead of just the one that actually contains them.
      // Excluding standard semantic chrome regions keeps this closer to
      // each page's actual content area.
      const rawLinks = await page.$$eval("a[href]", (as) =>
        as.filter((a) => !a.closest("nav, header, footer, aside")).map((a) => a.href)
      );
      console.log(`    found ${rawLinks.length} links on this page`);
      for (const rawLink of rawLinks) {
        // Match same-origin, not same-path-prefix: real product pages don't
        // necessarily live under the exact same path as the category/hub
        // page you started from -- a startsWith(baseUrl) check would
        // exclude legitimate products on some sites. isDeeperThanHub()
        // (used below) is what actually keeps this scoped to the hub
        // page's own products instead of the whole site.
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
        if (!visited.has(link) && toVisit.length < 60) toVisit.push(link);
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
  if (foundStrict.size > 0) {
    console.log(
      `  WARNING: ${foundStrict.size} candidate product URL(s) found, but none carry a numeric product-id suffix -- there's no strong signal telling real products apart from other listing pages here, so results may include pages that don't actually belong to this category. Spot-check the output before trusting it.`
    );
    return [...foundStrict];
  }
  console.log(`  No strict matches while crawling. ${foundLoose.size} loose matches found instead.`);
  if (foundLoose.size > 0) {
    console.log(
      `  WARNING: falling back to the loosest match heuristic -- these are same-origin links deeper than the hub page with no other product signal, so mismatched/unrelated pages are more likely. Spot-check the output before trusting it.`
    );
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
    return `${categorySlug}/images/${filename}`;
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

// schema.org JSON-LD ("Product" structured data) is a standards-based way
// most e-commerce/catalog platforms already expose their own product name
// and brand for search engines -- reading it directly works generically
// across many different site platforms without any site-specific rules.
// Falls back through common meta-tag conventions, then a "<Name> ... By
// <Brand>" pattern near the main heading, then breadcrumb text, in
// roughly descending order of reliability.
async function extractProductInfo(page) {
  return page.evaluate(() => {
    const textOf = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const brandNameOf = (brand) => {
      if (!brand) return null;
      if (typeof brand === "string") return brand.trim() || null;
      if (typeof brand === "object") return (brand.name || "").trim() || null;
      return null;
    };
    // Several sites bake "<Product Name> By <Brand>" into a single title
    // string (og:title, <h1>, etc.) rather than exposing the brand
    // separately, so this split is applied to whichever title text is
    // found, not just one specific source.
    const splitByPattern = (title) => {
      if (!title) return { productName: null, manufacturer: null };
      const m = title.match(/^(.*?)\s+by\s+(.+)$/i);
      if (m) return { productName: m[1].trim() || null, manufacturer: m[2].trim() || null };
      return { productName: title.trim() || null, manufacturer: null };
    };

    for (const block of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(block.textContent);
      } catch {
        continue;
      }
      const candidates = Array.isArray(data) ? data : Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      for (const item of candidates) {
        if (!item || typeof item !== "object") continue;
        const type = item["@type"];
        const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
        if (!isProduct) continue;
        const productName = (item.name || "").trim() || null;
        const manufacturer = brandNameOf(item.brand) || brandNameOf(item.manufacturer);
        if (productName || manufacturer) return { productName, manufacturer };
      }
    }

    const title =
      document.querySelector('meta[property="og:title"]')?.content ||
      textOf(document.querySelector('[itemprop="name"]')) ||
      textOf(document.querySelector("h1"));
    const explicitBrand =
      document.querySelector('meta[property="product:brand"]')?.content ||
      document.querySelector('meta[itemprop="brand"]')?.content ||
      textOf(document.querySelector('[itemprop="brand"] [itemprop="name"]')) ||
      textOf(document.querySelector('[itemprop="brand"]'));

    const split = splitByPattern(title);
    if (explicitBrand) return { productName: split.productName, manufacturer: explicitBrand.trim() };
    if (split.manufacturer) return split;

    // Breadcrumb trail -- the crumb just before the current page is often
    // the brand/category the product belongs to.
    const crumbs = [
      ...document.querySelectorAll('nav[aria-label="breadcrumb"] a, .breadcrumb a, [class*="breadcrumb"] a'),
    ]
      .map(textOf)
      .filter(Boolean);

    return { productName: split.productName, manufacturer: crumbs.length ? crumbs[crumbs.length - 1] : null };
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

  // A domain-wide sitemap.xml lists every product on the whole site, with
  // nothing in it tying a given URL back to the specific category/hub page
  // the user asked to scrape. That's a correct source when baseUrl *is*
  // the site root (scrape everything), but for a category/hub page it
  // would silently return an unrelated slice of the whole catalog instead
  // of that category's own products -- so only trust it at the root, and
  // otherwise discover via crawling from the hub page itself, which is
  // inherently scoped to whatever that specific page actually links to.
  let productUrls = [];
  if (baseUrlDepth === 0) {
    productUrls = await discoverViaSitemap();
  } else {
    console.log(
      "Base URL is a specific category/hub page, not the site root -- skipping sitemap discovery (it isn't scoped to this category) and crawling from the hub page instead.\n"
    );
  }
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
      const { productName, manufacturer } = await extractProductInfo(page);

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
        manufacturer: manufacturer || null,
        productName: productName || null,
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
