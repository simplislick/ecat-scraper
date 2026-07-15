// lib/discover.js
// Given a hub/landing page URL, extract candidate category/product-line
// links from it. This is intentionally a broad, permissive heuristic (same
// origin, not an obvious non-content page) rather than a precise one --
// every site organizes its nav differently, so the result is meant to be
// reviewed and edited by a human before anything is scraped, not queued
// automatically.

const EXCLUDE_HINTS = [
  "/blog/", "/blogs/", "/news/", "/about", "/contact", "/cart", "/checkout",
  "/account", "/login", "/register", "/policy", "/policies", "/terms",
  "/privacy", "/faq", "/pages/", "/page/", "/search", "/wishlist",
  "/careers", "/press", "/sitemap", ".xml", ".pdf", "/tag/", "/tags/",
  "mailto:", "tel:", "javascript:",
];

const MAX_CANDIDATES = 40;

function titleizeSlug(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function discoverCategoryLinks(browser, hubUrl) {
  const page = await browser.newPage();
  let raw;
  try {
    await page.goto(hubUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Site-wide chrome (nav bars, mega-menu dropdowns, footers) often renders
    // every link up front in the DOM, ahead of the page's actual content --
    // without excluding it, those links alone can fill the whole candidate
    // list before the loop ever reaches the hub page's real category tiles.
    // Same semantic-tag exclusion scrape.js's crawler already uses.
    raw = await page.$$eval("a[href]", (as) =>
      as
        .filter((a) => !a.closest("nav, header, footer, aside"))
        .map((a) => ({ href: a.href, text: a.textContent.replace(/\s+/g, " ").trim() }))
    );
  } finally {
    await page.close();
  }

  const hubOrigin = new URL(hubUrl).origin;
  const hubPath = new URL(hubUrl).pathname.replace(/\/$/, "");

  const seen = new Set();
  const candidates = [];

  for (const { href, text } of raw) {
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      continue;
    }
    if (parsed.origin !== hubOrigin) continue;

    const normalizedPath = parsed.pathname.replace(/\/$/, "");
    if (!normalizedPath || normalizedPath === hubPath) continue;

    const lower = href.toLowerCase();
    if (EXCLUDE_HINTS.some((hint) => lower.includes(hint))) continue;

    const key = parsed.origin + normalizedPath;
    if (seen.has(key)) continue;
    seen.add(key);

    const lastSegment = normalizedPath.split("/").filter(Boolean).pop() || "";
    const label = text && text.length <= 40 ? text : titleizeSlug(lastSegment);

    candidates.push({ url: parsed.origin + normalizedPath, label });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}

module.exports = { discoverCategoryLinks };
