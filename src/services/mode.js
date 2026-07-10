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

// ─── Parse content response (Mode returns content.json as a flat ──
// array of row objects, e.g. [{reporting_day: "...", brand_name: "...", ...}, ...]
function parseContent(content) {
  let rows = [];

  if (Array.isArray(content)) {
    // Could be: array of row objects (Mode's actual format), OR
    // legacy array-of-one wrapper [{columns, rows}]
    if (content.length > 0 && content[0]?.columns && content[0]?.rows) {
      // Legacy wrapper format
      const first = content[0];
      const colNames = (first.columns || []).map(c => (typeof c === 'object' ? (c.name || c.label) : c));
      rows = (first.rows || []).map(row =>
        Array.isArray(row) ? Object.fromEntries(colNames.map((n, i) => [n, row[i]])) : row
      );
    } else {
      // Direct array of row objects — this is Mode's actual format
      rows = content;
    }
  } else if (content?.columns && content?.rows) {
    const colNames = content.columns.map(c => (typeof c === 'object' ? (c.name || c.label) : c));
    rows = content.rows.map(row =>
      Array.isArray(row) ? Object.fromEntries(colNames.map((n, i) => [n, row[i]])) : row
    );
  } else if (content?.content) {
    return parseContent(content.content);
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  console.log(`[mode] parsed → ${columns.length} columns, ${rows.length} rows`);
  return { columns, rows, rawCount: rows.length };
}

// ─── Fetch run results (Mode's direct content.json endpoint) ──
async function getResults(reportToken, runToken) {
  const runPath = `/api/${WORKSPACE}/reports/${reportToken}/runs/${runToken}`;
  const content  = await modeRequest(`${runPath}/results/content.json`);
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
