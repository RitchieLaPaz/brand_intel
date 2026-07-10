// src/services/data.js — Orchestrates Mode API → cache → narrative pipeline
// Parameter contract: brand_name (canonical) + timeframe → computed start/end dates
// Mode receives: { brand_name, start_date, end_date }

const db         = require('../db');
const { runReport }         = require('./mode');
const { generateNarrative } = require('./anthropic');

const REPORT_TYPES = ['sales','inventory','promo','tdp','rankings','pricing','orders','campaigns'];

// ─── Timeframe → date range computation ──────────────────────
// Mode receives pre-computed YYYY-MM-DD dates — no CASE logic needed in SQL

function computeDateRange(timeframe, customStart, customEnd) {
  const now   = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const fmt   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  switch (timeframe) {
    case 'day':
      return { start_date: today, end_date: today };

    case 'week': {
      const d    = new Date(now);
      const day  = d.getDay();
      const diff = day === 0 ? -6 : 1 - day; // Monday start
      d.setDate(d.getDate() + diff);
      return { start_date: fmt(d), end_date: today };
    }

    case 'month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start_date: fmt(d), end_date: today };
    }

    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3);
      const d = new Date(now.getFullYear(), q * 3, 1);
      return { start_date: fmt(d), end_date: today };
    }

    case 'ytd': {
      const d = new Date(now.getFullYear(), 0, 1);
      return { start_date: fmt(d), end_date: today };
    }

    case 'custom':
      if (!customStart || !customEnd) throw new Error('custom timeframe requires start_date and end_date');
      return { start_date: customStart, end_date: customEnd };

    default: {
      // fallback: current month
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start_date: fmt(d), end_date: today };
    }
  }
}

// ─── Fetch data with stale-while-revalidate cache ─────────────
// brandName: canonical name e.g. 'Jeeter'
// timeframe: day|week|month|quarter|ytd|custom
// customStart/customEnd: YYYY-MM-DD (only for custom)

async function getData(brandName, reportType, timeframe = 'month', customStart, customEnd) {
  const brand = await db.getBrandByName(brandName);
  if (!brand) throw new Error(`Brand not found: ${brandName}`);

  // Report tokens are GLOBAL — same report works for every brand via {{brand_name}} param
  const reportToken = await db.getReportToken(reportType);
  if (!reportToken) throw new Error(`No Mode report configured for report type: ${reportType}`);

  const { start_date, end_date } = computeDateRange(timeframe, customStart, customEnd);

  // Cache check
  const cached = await db.getCached(brandName, reportType, start_date, end_date, timeframe);

  if (cached && !cached.isStale) {
    return { data: cached.data, source: 'cache', fetchedAt: cached.fetchedAt };
  }

  if (cached && cached.isStale) {
    _refreshInBackground(brand, reportToken, brandName, reportType, timeframe, start_date, end_date);
    return { data: cached.data, source: 'cache-stale', fetchedAt: cached.fetchedAt };
  }

  return _fetchFromMode(brand, reportToken, brandName, reportType, timeframe, start_date, end_date);
}

async function _fetchFromMode(brand, reportToken, brandName, reportType, timeframe, start_date, end_date) {
  const t0 = Date.now();
  try {
    // Mode receives: brand_name + computed dates (no timeframe needed in SQL)
    const params = { brand_name: brandName, start_date, end_date };
    const result = await runReport(reportToken, params);
    await db.setCache(brandName, reportType, start_date, end_date, timeframe, result,
                      Number(process.env.CACHE_TTL_HOURS) || 24);
    await db.logApiCall(brandName, reportType, 'mode', reportToken, Date.now() - t0, true);
    return { data: result, source: 'mode', fetchedAt: new Date() };
  } catch (err) {
    await db.logApiCall(brandName, reportType, 'mode', reportToken, Date.now() - t0, false, err.message);
    throw err;
  }
}

function _refreshInBackground(brand, reportToken, brandName, reportType, timeframe, start_date, end_date) {
  _fetchFromMode(brand, reportToken, brandName, reportType, timeframe, start_date, end_date)
    .catch(err => console.error(`[data] background refresh failed ${brandName}/${reportType}:`, err.message));
}

// ─── Narrative (Anthropic) ────────────────────────────────────

async function getNarrative(brandName, reportType, timeframe = 'month', customStart, customEnd) {
  const cached = await db.getNarrative(brandName, reportType);
  if (cached) return { text: cached, source: 'cache' };

  let dataResult;
  try {
    dataResult = await getData(brandName, reportType, timeframe, customStart, customEnd);
  } catch { return { text: null, source: 'error' }; }

  const brand  = await db.getBrandByName(brandName);
  const { start_date, end_date } = computeDateRange(timeframe, customStart, customEnd);
  const rows = dataResult.data?.rows ?? [];

  try {
    const { text, tokensUsed } = await generateNarrative(brand.brand_name, reportType,
                                                          `${start_date} to ${end_date}`, rows);
    await db.setNarrative(brandName, reportType, text, tokensUsed,
                          Number(process.env.CACHE_TTL_HOURS) || 24);
    return { text, source: 'anthropic' };
  } catch (err) {
    console.error(`[narrative] failed ${brandName}/${reportType}:`, err.message);
    return { text: null, source: 'error' };
  }
}

// ─── Bulk refresh (daily cron) ────────────────────────────────

async function refreshBrand(brandName, timeframe = 'month') {
  const brand = await db.getBrandByName(brandName);
  if (!brand) return;
  const { start_date, end_date } = computeDateRange(timeframe);
  const results = [];
  for (const reportType of REPORT_TYPES) {
    const token = await db.getReportToken(reportType);
    if (!token) continue;
    try {
      await _fetchFromMode(brand, token, brandName, reportType, timeframe, start_date, end_date);
      results.push({ reportType, success: true });
    } catch (err) {
      results.push({ reportType, success: false, error: err.message });
    }
  }
  return results;
}

module.exports = { getData, getNarrative, refreshBrand, computeDateRange, REPORT_TYPES };
