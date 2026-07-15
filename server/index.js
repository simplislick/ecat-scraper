// server/index.js
// Small local API that wraps scrape.js so the web UI can queue up one or
// more scrapes (e.g. one URL per product category on the same supplier
// site), run them one at a time, stream progress live, and download the
// resulting JSON.

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { launchBrowser } = require("../lib/browser");
const { discoverCategoryLinks } = require("../lib/discover");

const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");

const app = express();
app.use(cors());
app.use(express.json());

// batchId -> { jobs: [{url, limit, category, domain, status}], logs, clients, status, merged }
const batches = new Map();

function domainFromUrl(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9.-]+$/.test(domain);
}

// When a batch includes multiple category-tagged jobs for the same domain,
// scrape.js writes each one to its own <tag>-raw-pages.json to avoid
// clobbering. This combines every *-raw-pages.json file in that domain's
// output folder into the single <domain>-raw-pages.json file the rest of
// the app (and Claude Code's extraction step) expects, deduping by
// sourceUrl so re-running a category overwrites its old entries.
function mergeDomainOutputs(domain) {
  const domainDir = path.join(OUTPUT_DIR, domain);
  const mainFile = path.join(domainDir, `${domain}-raw-pages.json`);
  if (!fs.existsSync(domainDir)) return { domain, count: 0 };

  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith("-raw-pages.json"));
  if (files.length <= 1) {
    let count = 0;
    if (fs.existsSync(mainFile)) {
      try {
        count = JSON.parse(fs.readFileSync(mainFile, "utf-8")).length;
      } catch {
        count = 0;
      }
    }
    return { domain, count };
  }

  const bySourceUrl = new Map();
  for (const file of files) {
    try {
      const records = JSON.parse(fs.readFileSync(path.join(domainDir, file), "utf-8"));
      for (const record of records) {
        if (record && record.sourceUrl) bySourceUrl.set(record.sourceUrl, record);
      }
    } catch {
      // skip unreadable file
    }
  }

  const merged = [...bySourceUrl.values()];
  fs.writeFileSync(mainFile, JSON.stringify(merged, null, 2));
  return { domain, count: merged.length };
}

async function runBatch(batch, pushEvent) {
  for (let i = 0; i < batch.jobs.length; i++) {
    const job = batch.jobs[i];
    job.status = "running";
    const label = job.category || job.domain;
    pushEvent("job-start", { jobIndex: i, url: job.url, category: job.category, domain: job.domain, label });

    const args = [path.join(ROOT, "scrape.js"), job.url, "--limit", String(job.limit)];
    if (job.category) args.push("--tag", job.category);

    await new Promise((resolve) => {
      const proc = spawn(process.execPath, args, { cwd: ROOT });

      proc.stdout.on("data", (d) =>
        pushEvent("log", { jobIndex: i, label, text: d.toString(), stream: "stdout" })
      );
      proc.stderr.on("data", (d) =>
        pushEvent("log", { jobIndex: i, label, text: d.toString(), stream: "stderr" })
      );
      proc.on("close", (code) => {
        job.status = code === 0 ? "done" : "error";
        pushEvent("job-complete", { jobIndex: i, status: job.status });
        resolve();
      });
      proc.on("error", (err) => {
        job.status = "error";
        pushEvent("log", { jobIndex: i, label, text: `Failed to start scraper: ${err.message}`, stream: "stderr" });
        pushEvent("job-complete", { jobIndex: i, status: "error" });
        resolve();
      });
    });
  }

  const uniqueDomains = [...new Set(batch.jobs.map((j) => j.domain))];
  batch.merged = uniqueDomains.map(mergeDomainOutputs);
  batch.status = "done";
  pushEvent("batch-complete", { status: "done", merged: batch.merged });
  for (const client of batch.clients) client.end();
  batch.clients.clear();
}

app.post("/api/scrape-batch", (req, res) => {
  const { jobs } = req.body || {};
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: "jobs must be a non-empty array" });
  }

  const parsedJobs = [];
  for (const j of jobs) {
    if (!j || typeof j.url !== "string" || !j.url.trim()) {
      return res.status(400).json({ error: "Each job needs a url" });
    }
    let domain;
    try {
      domain = domainFromUrl(j.url.trim());
    } catch {
      return res.status(400).json({ error: `That doesn't look like a valid URL: ${j.url}` });
    }
    parsedJobs.push({
      url: j.url.trim(),
      limit: j.limit ? parseInt(j.limit, 10) || 100 : 100,
      category: j.category && String(j.category).trim() ? String(j.category).trim() : null,
      domain,
      status: "pending",
    });
  }

  const batchId = crypto.randomUUID();
  const batch = { jobs: parsedJobs, logs: [], clients: new Set(), status: "running", merged: [] };
  batches.set(batchId, batch);

  const pushEvent = (event, data) => {
    const line = { event, data };
    batch.logs.push(line);
    for (const client of batch.clients) {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  runBatch(batch, pushEvent).catch((err) => {
    batch.status = "error";
    pushEvent("batch-complete", { status: "error", error: err.message, merged: batch.merged });
    for (const client of batch.clients) client.end();
    batch.clients.clear();
  });

  res.json({ batchId, jobs: parsedJobs.map((j) => ({ url: j.url, category: j.category, domain: j.domain })) });
});

app.get("/api/scrape-batch/:batchId/events", (req, res) => {
  const batch = batches.get(req.params.batchId);
  if (!batch) return res.status(404).end();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  for (const line of batch.logs) {
    res.write(`event: ${line.event}\ndata: ${JSON.stringify(line.data)}\n\n`);
  }

  if (batch.status !== "running") {
    return res.end();
  }

  batch.clients.add(res);
  req.on("close", () => batch.clients.delete(res));
});

app.post("/api/discover", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string" || !url.trim()) {
    return res.status(400).json({ error: "url is required" });
  }

  let hubUrl;
  try {
    hubUrl = new URL(url.trim()).toString();
  } catch {
    return res.status(400).json({ error: "That doesn't look like a valid URL" });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const candidates = await discoverCategoryLinks(browser, hubUrl);
    res.json({ candidates });
  } catch (err) {
    res.status(502).json({ error: `Could not discover links: ${err.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

app.get("/api/outputs", (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) return res.json([]);

  const entries = fs
    .readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const domain = d.name;
      const domainDir = path.join(OUTPUT_DIR, domain);
      const filePath = path.join(domainDir, `${domain}-raw-pages.json`);
      const exists = fs.existsSync(filePath);
      let count = 0;
      if (exists) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          count = Array.isArray(data) ? data.length : 0;
        } catch {
          count = 0;
        }
      }

      // Sort by the most recent activity anywhere in this domain's folder,
      // not just the merged file -- otherwise a scrape that just ran but
      // found 0 products (no raw-pages.json ever written) sinks to the
      // bottom instead of showing up as the most recent attempt.
      let mtime = null;
      try {
        mtime = fs.statSync(domainDir).mtime;
      } catch {
        // folder vanished between readdir and stat -- leave mtime null
      }
      try {
        for (const f of fs.readdirSync(domainDir)) {
          if (!f.endsWith("-raw-pages.json")) continue;
          const stat = fs.statSync(path.join(domainDir, f));
          if (!mtime || stat.mtime > mtime) mtime = stat.mtime;
        }
      } catch {
        // ignore, mtime already has the folder's own timestamp
      }

      return { domain, exists, count, mtime };
    })
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

  res.json(entries);
});

app.get("/api/download/:domain", (req, res) => {
  const { domain } = req.params;
  if (!isValidDomain(domain)) return res.status(400).end();

  const filePath = path.join(OUTPUT_DIR, domain, `${domain}-raw-pages.json`);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  res.download(filePath, `${domain}-raw-pages.json`);
});

// Opens the domain's local output folder (where the raw-pages JSON lives)
// in the OS file explorer. Only makes sense because this server runs on
// the user's own machine for their own use -- never expose this endpoint
// outside localhost.
app.post("/api/open-folder/:domain", (req, res) => {
  const { domain } = req.params;
  if (!isValidDomain(domain)) return res.status(400).json({ error: "Invalid domain" });

  const domainDir = path.join(OUTPUT_DIR, domain);
  if (!fs.existsSync(domainDir)) {
    return res.status(404).json({ error: "No output folder for this domain yet" });
  }

  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [domainDir]]
      : process.platform === "darwin"
      ? ["open", [domainDir]]
      : ["xdg-open", [domainDir]];

  // explorer.exe commonly exits with code 1 even on success, so this is
  // fire-and-forget rather than treated as a request failure.
  execFile(cmd, args, () => {});
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`eCAT scraper API listening on http://localhost:${PORT}`);
});
