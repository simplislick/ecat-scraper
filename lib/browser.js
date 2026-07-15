// lib/browser.js
// Shared Puppeteer launch logic used by scrape.js and the discovery endpoint.
// Falls back to a system-installed Chrome/Edge when the bundled Chromium
// isn't available (e.g. stripped by corporate antivirus).

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

function findSystemChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];

  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function launchBrowser() {
  try {
    return await puppeteer.launch({ headless: true });
  } catch {
    const systemChrome = findSystemChrome();
    if (!systemChrome) {
      throw new Error(
        "Could not find a usable Chrome/Edge install. Run `npx puppeteer browsers install chrome` " +
          "or set a CHROME_PATH environment variable pointing at chrome.exe / msedge.exe, then retry."
      );
    }
    console.log(`Bundled Chromium not found -- using installed browser at:\n  ${systemChrome}\n`);
    return await puppeteer.launch({ headless: true, executablePath: systemChrome });
  }
}

module.exports = { launchBrowser, findSystemChrome };
