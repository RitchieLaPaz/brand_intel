// src/services/mode.js — Mode Analytics REST API client
const https = require('https');
const zlib  = require('zlib');

const MODE_BASE   = 'https://app.mode.com';
const WORKSPACE   = process.env.MODE_WORKSPACE;   // confirmed: eazeup
const MODE_TOKEN  = process.env.MODE_API_TOKEN;
const MODE_SECRET = process.env.MODE_API_SECRET;

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS  = 120_000;

// ─── HTTP wrapper with gzip decompression ────────────────────
function modeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const auth    = Buffer.from(`${MODE_TOKEN}:${MODE_SECRET}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      method,
      headers: {
        Authorization:    `Basic ${auth}`,
        Accept:           'application/json',
        'Accept-Encoding':'gzip, deflate',
        'Content-Type':   'application/json',
        ...(payload && { 'Content-Length': Buffer.byteLength(payload) }),
      },
    };
    const req = https.request(`${MODE_BASE}${path}`, options, (res) => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      let data = '';
      stream.on('data', chunk => (data += chunk));
      stream.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Mode API ${res.statusCode}: ${parsed.message ?? data.slice(0, 300)}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Mode non-JSON (${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Create a report run ──────────────────────────────────────
async function createRun(reportToken, params) {
  const path = `/api/${WORKSPACE}/reports/${reportToken}/runs`;
  const run  = await modeRequest(path, 'POST', { parameters: params });
  const token = run.token || run._links?.self?.href?.split('/').pop();
  console.log(`[mode] created run ${token} for report ${reportToken}`);
  return token;
}

// ─── Poll until run completes ─────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForRun(reportToken, runToken) {
  const path    = `/api/${WORKSPACE}/reports/${reportToken}/runs/${runToken}`;
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const run   = await modeRequest(path);
    const state = run.state;
    console.log(`[mode] run ${runToken} state: ${state}`);
    if (state === 'succeeded') return run;
    if (state === 'failed')    throw new Error(`Mode run failed: ${run.error_message ?? 'unknown'}`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Mode run timed out after ${POLL_TIMEOUT_MS / 1000}s`);
}

// ─── Parse content response (handles Mode's formats) ─────────
function parseContent(content) {
  let columns = [];
  let rows    = [];

  if (Array.isArray(content)) {
    // Array of query results — take the first
    const first = content[0] || {};
    columns = first.columns || [];
    rows    = first.rows    || [];
  } else if (content?.columns) {
    columns = content.columns;
    rows    = content.rows || [];
  } else if (content?.content) {
    columns = content.content.columns || [];
    rows    = content.content.rows    || [];
  }

  // columns can be strings or {name, ...} objects
  const colNames = columns.map(c => (typeof c === 'object' ? (c.name || c.label || String(c)) : c));

  // rows can be arrays [val, ...] or already objects {col: val}
  const normalized = rows.map(row =>
    Array.isArray(row)
      ? Object.fromEntries(colNames.map((name, i) => [name, row[i]]))
      : row
  );

  console.log(`[mode] parsed → ${colNames.length} columns, ${normalized.length} rows`);
  return { columns: colNames, rows: normalized, rawCount: normalized.length };
}

// ─── Fetch run results (tries query_runs first, then fallback) ─
async function getResults(reportToken, runToken) {
  const runPath = `/api/${WORKSPACE}/reports/${reportToken}/runs/${runToken}`;

  // Step 1: get run details to find query_runs
  const run = await modeRequest(runPath);
  console.log('[mode] run top-level keys:', Object.keys(run).join(', '));

  // Mode nests query runs in _embedded or directly
  const queryRuns = run._embedded?.['mode:query_runs']
    || run._embedded?.query_runs
    || run.query_runs
    || [];

  console.log(`[mode] query_runs found: ${queryRuns.length}`);

  if (queryRuns.length > 0) {
    // Use first query_run's results
    const qr      = queryRuns[0];
    const qrToken = qr.token || qr.id;
    console.log(`[mode] fetching query_run ${qrToken} results`);
    const contentPath = `${runPath}/query_runs/${qrToken}/results/content.json`;
    const content = await modeRequest(contentPath);
    return parseContent(content);
  }

  // Fallback: try direct results endpoint
  console.log('[mode] no query_runs, trying direct content.json');
  const content = await modeRequest(`${runPath}/results/content.json`);
  console.log('[mode] direct content keys:', Object.keys(content).join(', '));
  return parseContent(content);
}

// ─── Main entry: run a report end-to-end ─────────────────────
async function runReport(reportToken, params) {
  if (!MODE_TOKEN || !MODE_SECRET || !WORKSPACE) {
    throw new Error('Mode credentials not configured (MODE_API_TOKEN, MODE_API_SECRET, MODE_WORKSPACE)');
  }
  const runToken = await createRun(reportToken, params);
  await waitForRun(reportToken, runToken);
  return getResults(reportToken, runToken);
}

async function listReports() {
  return modeRequest(`/api/${WORKSPACE}/reports`);
}

module.exports = { runReport, listReports };
