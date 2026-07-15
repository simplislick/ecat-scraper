import { useEffect, useRef, useState } from "react";

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

let nextRowId = 1;
function emptyRow() {
  return { id: nextRowId++, url: "", tags: [], tagInput: "" };
}

export default function App() {
  const [rows, setRows] = useState([emptyRow()]);
  const [limit, setLimit] = useState(10);
  const [hubUrl, setHubUrl] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [jobStatuses, setJobStatuses] = useState([]); // [{label, url, category, status}]
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [mergedResults, setMergedResults] = useState([]); // [{domain, count}]
  const [formError, setFormError] = useState(null);
  const [history, setHistory] = useState([]);
  const [sidebarTab, setSidebarTab] = useState("queue"); // queue | terminal
  const [folderError, setFolderError] = useState(null);
  const [killError, setKillError] = useState(null);
  const [killing, setKilling] = useState(false);
  const logRef = useRef(null);
  const batchIdRef = useRef(null);

  useEffect(() => {
    refreshHistory();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function refreshHistory() {
    try {
      const res = await fetch("/api/outputs");
      setHistory(await res.json());
    } catch {
      // ignore -- the history panel just stays empty
    }
  }

  function clampLimit(value) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return 1;
    return Math.min(500, Math.max(1, n));
  }

  function stepLimit(delta) {
    setLimit((prev) => clampLimit((parseInt(prev, 10) || 0) + delta));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(id) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  }

  function clearRows() {
    setRows([emptyRow()]);
    setFormError(null);
  }

  function updateRow(id, field, value) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addTag(id) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const tag = r.tagInput.trim();
        if (!tag || r.tags.includes(tag)) return { ...r, tagInput: "" };
        return { ...r, tags: [...r.tags, tag], tagInput: "" };
      })
    );
  }

  function removeTag(id, tag) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, tags: r.tags.filter((t) => t !== tag) } : r))
    );
  }

  async function runDiscovery() {
    setDiscoverError(null);
    if (!hubUrl.trim()) {
      setDiscoverError("Enter a hub page URL first");
      return;
    }

    setDiscovering(true);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: hubUrl.trim() }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setDiscoverError(data.error || "Discovery failed");
        return;
      }
      if (!data.candidates || data.candidates.length === 0) {
        setDiscoverError("No candidate links found on that page -- try adding URLs manually below.");
        return;
      }

      const discovered = data.candidates.map((c) => ({
        id: nextRowId++,
        url: c.url,
        tags: c.label ? [c.label] : [],
        tagInput: "",
      }));

      setRows((prev) => {
        const kept = prev.filter((r) => r.url.trim());
        return [...kept, ...discovered];
      });
    } catch {
      setDiscoverError("Could not reach the scraper API. Is the server running?");
    } finally {
      setDiscovering(false);
    }
  }

  function handleTagInputKeyDown(e, id) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(id);
    } else if (e.key === "Backspace" && !e.currentTarget.value) {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, tags: r.tags.slice(0, -1) } : r))
      );
    }
  }

  async function startBatch(e) {
    e.preventDefault();
    setFormError(null);

    const jobs = rows
      .filter((r) => r.url.trim())
      .map((r) => {
        const pending = r.tagInput.trim();
        const tags = pending && !r.tags.includes(pending) ? [...r.tags, pending] : r.tags;
        return { url: r.url.trim(), category: tags.length ? tags.join(", ") : undefined, limit };
      });

    if (jobs.length === 0) {
      setFormError("Add at least one URL");
      return;
    }

    setLogs([]);
    setMergedResults([]);
    setJobStatuses(
      jobs.map((j) => ({ label: j.category || j.url, url: j.url, category: j.category || null, status: "pending" }))
    );
    setStatus("running");

    let res;
    try {
      res = await fetch("/api/scrape-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs }),
      });
    } catch {
      setFormError("Could not reach the scraper API. Is the server running?");
      setStatus("idle");
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setFormError(err.error || "Failed to start scrape");
      setStatus("idle");
      return;
    }

    const { batchId } = await res.json();
    batchIdRef.current = batchId;

    const es = new EventSource(`/api/scrape-batch/${batchId}/events`);

    es.addEventListener("job-start", (ev) => {
      const { jobIndex, label } = JSON.parse(ev.data);
      setJobStatuses((prev) =>
        prev.map((j, i) => (i === jobIndex ? { ...j, label, status: "running" } : j))
      );
    });

    es.addEventListener("log", (ev) => {
      const line = JSON.parse(ev.data);
      setLogs((prev) => [...prev, line]);
    });

    es.addEventListener("job-complete", (ev) => {
      const { jobIndex, status: jobStatus } = JSON.parse(ev.data);
      setJobStatuses((prev) =>
        prev.map((j, i) => (i === jobIndex ? { ...j, status: jobStatus } : j))
      );
    });

    es.addEventListener("batch-complete", (ev) => {
      const payload = JSON.parse(ev.data);
      setStatus(payload.status);
      setMergedResults(payload.merged || []);
      es.close();
      refreshHistory();
    });

    es.onerror = () => {
      es.close();
    };
  }

  async function killBatch() {
    const batchId = batchIdRef.current;
    if (!batchId) return;
    setKillError(null);
    setKilling(true);
    try {
      const res = await fetch(`/api/kill-batch/${batchId}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setKillError(err.error || "Failed to kill the running batch");
      }
    } catch {
      setKillError("Could not reach the scraper API. Is the server running?");
    } finally {
      setKilling(false);
    }
  }

  function downloadJson(d) {
    window.location.href = `/api/download/${encodeURIComponent(d)}`;
  }

  async function openOutputFolder(domain) {
    setFolderError(null);
    try {
      const res = await fetch(`/api/open-folder/${encodeURIComponent(domain)}`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setFolderError(err.error || `Could not open the output folder for ${domain}`);
      }
    } catch {
      setFolderError("Could not reach the scraper API. Is the server running?");
    }
  }

  return (
    <div className="page">
      <header>
        <h1>eCAT Material Scraper</h1>
        <p className="subtitle">
          Queue one or more supplier URLs (e.g. one per product category), discover product pages,
          and export the raw data as JSON.
        </p>
      </header>

      <div className="layout">
      <div className="main">
      <section className="scrape-card">
      <form className="scrape-form" onSubmit={startBatch}>
        <div className="top-row">
          <div className="limit-card">
            <h3>Limit/URL</h3>
            <div className="limit-stepper">
              <button
                type="button"
                className="limit-btn minus"
                onClick={() => stepLimit(-1)}
                aria-label="Decrease limit"
              >
                &minus;
              </button>
              <input
                type="number"
                min="1"
                max="500"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                onBlur={(e) => setLimit(clampLimit(e.target.value))}
              />
              <button
                type="button"
                className="limit-btn plus"
                onClick={() => stepLimit(1)}
                aria-label="Increase limit"
              >
                +
              </button>
            </div>
          </div>

          <div className="discover-card">
            <h3>Get URLs</h3>

            <div className="discover-row">
              <input
                type="url"
                placeholder="https://www.heartglobal.net/acoustic-panels-all"
                value={hubUrl}
                onChange={(e) => setHubUrl(e.target.value)}
              />
              <button type="button" className="discover-btn" onClick={runDiscovery} disabled={discovering}>
                {discovering ? "Discovering…" : "Discover"}
              </button>
            </div>
            {discoverError && <p className="error-text">{discoverError}</p>}
          </div>
        </div>

        <div className="scrape-actions-row">
          <button type="submit" className="submit-btn" disabled={status === "running"}>
            {status === "running" ? "Scraping…" : `Start Scrape${rows.length > 1 ? " Queue" : ""}`}
          </button>
        </div>
        {formError && <p className="error-text">{formError}</p>}

        <div className="url-scrape-card">
          <h3>URL scrape</h3>

          <div className="queue">
            {rows.map((row, i) => (
              <div className="queue-row" key={row.id}>
                <input
                  type="url"
                  placeholder="https://www.heartglobal.net/acoustic-panels-all/premium"
                  value={row.url}
                  onChange={(e) => updateRow(row.id, "url", e.target.value)}
                  required={i === 0}
                />
                <div className="tag-input">
                  {row.tags.map((tag) => (
                    <span className="tag-chip" key={tag}>
                      {tag}
                      <button
                        type="button"
                        className="tag-chip-remove"
                        onClick={() => removeTag(row.id, tag)}
                        aria-label={`Remove tag ${tag}`}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    placeholder={row.tags.length ? "" : "Category tag (optional, e.g. Premium) — Enter to add"}
                    value={row.tagInput}
                    onChange={(e) => updateRow(row.id, "tagInput", e.target.value)}
                    onKeyDown={(e) => handleTagInputKeyDown(e, row.id)}
                    onBlur={() => addTag(row.id)}
                  />
                </div>
                <button
                  type="button"
                  className="remove-row"
                  onClick={() => removeRow(row.id)}
                  disabled={rows.length === 1}
                  aria-label="Remove row"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>

          <div className="row-actions">
            <button type="button" className="add-row" onClick={addRow}>
              + Add another URL
            </button>
            <button
              type="button"
              className="clear-rows"
              onClick={clearRows}
              disabled={rows.length === 1 && !rows[0].url.trim() && rows[0].tags.length === 0 && !rows[0].tagInput.trim()}
            >
              Clear all
            </button>
          </div>
        </div>

      </form>

      {status === "done" && mergedResults.length > 0 && (
        <div className="result-banner success">
          <span>
            Scrape complete —{" "}
            {mergedResults.map((m) => `${m.domain} (${m.count} items)`).join(", ")}
          </span>
          <div className="result-actions">
            {mergedResults.map((m) => (
              <button key={m.domain} onClick={() => downloadJson(m.domain)}>
                Export {m.domain}
              </button>
            ))}
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="result-banner error">
          <span>Scrape failed — check the Terminal tab in the queue panel for details.</span>
        </div>
      )}
      {status === "killed" && (
        <div className="result-banner error">
          <span>Scrape stopped — remaining queued jobs were cancelled.</span>
        </div>
      )}
      </section>

      <section className="history">
        <h2>Previous scrapes</h2>
        {history.length === 0 && <p className="muted">No scrapes yet.</p>}
        {folderError && <p className="error-text">{folderError}</p>}
        {history.map((h) => (
          <div key={h.domain} className="history-row">
            <div className="history-info">
              <span className="history-domain">{h.domain}</span>
              <span className="muted">
                {h.exists ? `${h.count} items · ${formatDate(h.mtime)}` : "no data file"}
              </span>
            </div>
            <div className="history-actions">
              <button onClick={() => openOutputFolder(h.domain)}>Open Output Folder</button>
            </div>
          </div>
        ))}
      </section>
      </div>

      <aside className="sidebar">
        <div className="sidebar-tabs">
          <button
            type="button"
            className={sidebarTab === "queue" ? "active" : ""}
            onClick={() => setSidebarTab("queue")}
          >
            Queue
          </button>
          <button
            type="button"
            className={sidebarTab === "terminal" ? "active" : ""}
            onClick={() => setSidebarTab("terminal")}
          >
            Terminal
          </button>
          {status === "running" && (
            <button
              type="button"
              className="kill-switch"
              onClick={killBatch}
              disabled={killing}
              title="Kill all running and queued jobs"
            >
              {killing ? "Killing…" : "Kill"}
            </button>
          )}
        </div>
        {killError && <p className="error-text">{killError}</p>}

        {sidebarTab === "queue" ? (
          jobStatuses.length === 0 ? (
            <p className="queue-empty">No jobs queued yet.</p>
          ) : (
            <div className="queue-list">
              {jobStatuses.map((j, i) => (
                <div className="queue-item" key={i}>
                  <span className={`queue-status-dot ${j.status}`} />
                  <div className="queue-item-text">
                    <span className="queue-item-label">{j.category || j.url}</span>
                    {j.category && <span className="queue-item-sub">{j.url}</span>}
                  </div>
                  <span className="queue-item-status">{j.status}</span>
                </div>
              ))}
            </div>
          )
        ) : logs.length === 0 ? (
          <p className="queue-empty">No output yet.</p>
        ) : (
          <div className="log-panel" ref={logRef}>
            {logs.map((l, i) => (
              <pre key={i} className={`log-line ${l.stream}`}>
                [{l.label}] {l.text}
              </pre>
            ))}
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
