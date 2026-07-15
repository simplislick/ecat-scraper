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

// spawn()'d scrape.js launches its own Puppeteer/Chrome subprocess. Killing
// just the immediate Node child (proc.kill) leaves that browser process
// orphaned and still running -- on Windows in particular, TerminateProcess
// doesn't cascade to children at all, so the "killed" job keeps consuming
// CPU/network in the background even though the batch is marked killed.
// This kills the whole process tree instead of just the top process.
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], () => {});
    return;
  }
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    if (proc.killed) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 3000);
}

function domainFromUrl(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9.-]+$/.test(domain);
}

// scrape.js writes each category's raw pages into its own
// output/<domain>/<domain>_<tag-slug>/<domain>_<tag-slug>-raw-pages.json
// (one subfolder per category, alongside that category's images/ folder).
// This walks every
// subfolder under the domain looking for *-raw-pages.json files and combines
// them into the single output/<domain>/<domain>-raw-pages.json file the rest
// of the app (and Claude Code's extraction step) expects, deduping by
// sourceUrl so re-running a category overwrites its old entries.
function findRawPagesFiles(dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findRawPagesFiles(full));
    } else if (entry.isFile() && entry.name.endsWith("-raw-pages.json")) {
      results.push(full);
    }
  }
  return results;
}

function mergeDomainOutputs(domain) {
  const domainDir = path.join(OUTPUT_DIR, domain);
  const mainFile = path.join(domainDir, `${domain}-raw-pages.json`);
  if (!fs.existsSync(domainDir)) return { domain, count: 0 };

  const files = findRawPagesFiles(domainDir).filter((f) => f !== mainFile);
  if (files.length === 0) {
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
      const records = JSON.parse(fs.readFileSync(file, "utf-8"));
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
    if (batch.status === "killed") break;
    const job = batch.jobs[i];
    job.status = "running";
    const label = job.category || job.domain;
    pushEvent("job-start", { jobIndex: i, url: job.url, category: job.category, domain: job.domain, label });

    const args = [path.join(ROOT, "scrape.js"), job.url, "--limit", String(job.limit)];
    if (job.category) args.push("--tag", job.category);

    await new Promise((resolve) => {
      const proc = spawn(process.execPath, args, { cwd: ROOT, detached: process.platform !== "win32" });
      batch.procs.push(proc);

      proc.stdout.on("data", (d) =>
        pushEvent("log", { jobIndex: i, label, text: d.toString(), stream: "stdout" })
      );
      proc.stderr.on("data", (d) =>
        pushEvent("log", { jobIndex: i, label, text: d.toString(), stream: "stderr" })
      );
      proc.on("close", (code) => {
        if (job.status !== "killed") job.status = code === 0 ? "done" : "error";
        pushEvent("job-complete", { jobIndex: i, status: job.status });
        resolve();
      });
      proc.on("error", (err) => {
        if (job.status !== "killed") job.status = "error";
        pushEvent("log", { jobIndex: i, label, text: `Failed to start scraper: ${err.message}`, stream: "stderr" });
        pushEvent("job-complete", { jobIndex: i, status: "error" });
        resolve();
      });
    });
  }

  const uniqueDomains = [...new Set(batch.jobs.map((j) => j.domain))];
  batch.merged = uniqueDomains.map(mergeDomainOutputs);
  if (batch.status !== "killed") batch.status = "done";
  pushEvent("batch-complete", { status: batch.status, merged: batch.merged });
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
      limit: j.limit ? parseInt(j.limit, 10) || 10 : 10,
      category: j.category && String(j.category).trim() ? String(j.category).trim() : null,
      domain,
      status: "pending",
    });
  }

  const batchId = crypto.randomUUID();
  const batch = { jobs: parsedJobs, logs: [], clients: new Set(), status: "running", merged: [], procs: [] };
  batches.set(batchId, batch);

  const pushEvent = (event, data) => {
    const line = { event, data };
    batch.logs.push(line);
    for (const client of batch.clients) {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  batch.pushEvent = pushEvent;

  runBatch(batch, pushEvent).catch((err) => {
    batch.status = "error";
    pushEvent("batch-complete", { status: "error", error: err.message, merged: batch.merged });
    for (const client of batch.clients) client.end();
    batch.clients.clear();
  });

  res.json({ batchId, jobs: parsedJobs.map((j) => ({ url: j.url, category: j.category, domain: j.domain })) });
});

app.post("/api/kill-batch/:batchId", (req, res) => {
  const batch = batches.get(req.params.batchId);
  if (!batch) return res.status(404).json({ error: "Batch not found" });
  // Idempotent: a batch that already finished or was already killed just
  // reports success with nothing left to kill, instead of erroring -- a
  // stray double-click (e.g. while the UI hasn't caught up with the last
  // kill yet) shouldn't look like the killswitch failed.
  if (batch.status !== "running") return res.json({ ok: true, killed: 0 });

  batch.status = "killed";
  for (const proc of batch.procs) {
    killProcessTree(proc);
  }

  batch.jobs.forEach((job, jobIndex) => {
    if (job.status === "pending" || job.status === "running") {
      job.status = "killed";
      batch.pushEvent("job-complete", { jobIndex, status: "killed" });
    }
  });

  res.json({ ok: true, killed: batch.procs.length });
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
        for (const f of findRawPagesFiles(domainDir)) {
          const stat = fs.statSync(f);
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
