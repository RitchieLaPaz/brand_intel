// src/services/mode.js — Mode Analytics REST API client
//
// Mode report run lifecycle:
//   POST /runs → run token (async, state: enqueued → running → succeeded/failed)
//   GET  /runs/:token → poll state
//   GET  /runs/:token/results/content.json → fetch rows
//
// Parameters passed per run: brand_id, start_date, end_date, channel
// These must match the {{param}} syntax in your Mode SQL queries.

const https = require('https');

const MODE_BASE   = 'https://app.mode.com';
const WORKSPACE   = process.env.MODE_WORKSPACE;   // confirmed: eazeup
const MODE_TOKEN  = process.env.MODE_API_TOKEN;
const MODE_SECRET = process.env.MODE_API_SECRET;

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS  = 120_000; // 2 min max per run

// ─── Low-level fetch wrapper ──────────────────────────────────

function modeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`${MODE_TOKEN}:${MODE_SECRET}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      headers: {
        Authorization:  `Basic ${auth}`,
        Accept:         'application/json',
        'Content-Type': 'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };
    const req = https.request(`${MODE_BASE}${path}`, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Mode API ${res.statusCode}: ${parsed.message ?? data}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Mode API non-JSON response (${res.statusCode}): ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Create a report run ──────────────────────────────────────
// reportToken: Mode report token (stored in brands.mode_reports JSON)
// params: { brand_id, start_date, end_date, channel }

async function createRun(reportToken, params) {
  const path = `/api/${WORKSPACE}/reports/${reportToken}/runs`;
  const run  = await modeRequest(path, 'POST', { parameters: params });
  // run._links.self.href contains the run URL
  return run.token || run._links?.self?.href?.split('/').pop();
}

// ─── Poll run until complete ──────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRun(reportToken, runToken) {
  const path    = `/api/${WORKSPACE}/reports/${reportToken}/runs/${runToken}`;
  const started = Date.now();

  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const run = await modeRequest(path);
    const state = run.state;

    if (state === 'succeeded') return run;
    if (state === 'failed')    throw new Error(`Mode run failed: ${run.error_message ?? 'unknown'}`);
    // states: enqueued | pending | running | succeeded | failed | cancelled
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Mode run timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ─── Fetch run results ────────────────────────────────────────
// Returns { columns: [...], rows: [{col: val, ...}, ...] }

async function getResults(reportToken, runToken) {
  const path    = `/api/${WORKSPACE}/reports/${reportToken}/runs/${runToken}/results/content.json`;
  const content = await modeRequest(path);

  // Mode returns { columns: [{name, type}], rows: [[val, ...], ...] }
  // Normalize to array of objects for easier downstream use
  const { columns = [], rows = [] } = content;
  const colNames = columns.map((c) => c.name);
  const normalized = rows.map((row) =>
    Object.fromEntries(colNames.map((name, i) => [name, row[i]]))
  );
  return { columns: colNames, rows: normalized, rawCount: rows.length };
}

// ─── Main: run a report end-to-end ───────────────────────────
// reportToken: from brands.mode_reports[reportType]
// params: { brand_id, start_date, end_date, channel }

async function runReport(reportToken, params) {
  if (!MODE_TOKEN || !MODE_SECRET || !WORKSPACE) {
    throw new Error('Mode credentials not configured (MODE_API_TOKEN, MODE_API_SECRET, MODE_WORKSPACE)');
  }

  const runToken = await createRun(reportToken, params);
  await waitForRun(reportToken, runToken);
  return getResults(reportToken, runToken);
}

// ─── List reports (useful for setup / verifying tokens) ───────

async function listReports() {
  return modeRequest(`/api/${WORKSPACE}/reports`);
}

module.exports = { runReport, listReports };
