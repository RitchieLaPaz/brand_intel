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

    case 'yesterday': {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { start_date: fmt(d), end_date: fmt(d) };
    }

    case 'week': {
      const d    = new Date(now);
      const day  = d.getDay();
      const diff = day === 0 ? -6 : 1 - day; // Monday start
      d.setDate(d.getDate() + diff);
      return { start_date: fmt(d), end_date: today };
    }

    case 'last_week': {
      // This week's Monday, then shift back 7 days for last week's Monday–Sunday
      const d    = new Date(now);
      const day  = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);        // this week's Monday
      d.setDate(d.getDate() - 7);            // last week's Monday
      const start = new Date(d);
      const end   = new Date(d); end.setDate(end.getDate() + 6); // last week's Sunday
      return { start_date: fmt(start), end_date: fmt(end) };
    }

    case 'month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start_date: fmt(d), end_date: today };
    }

    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end   = new Date(now.getFullYear(), now.getMonth(), 0); // day 0 = last day of prev month
      return { start_date: fmt(start), end_date: fmt(end) };
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

// ─── Channel-aware fetching (Delivery + Retail) ────────────────
// Retail lives in a separate Postgres source (Sweed RO), not the same
// Redshift cluster as delivery — Mode can't join across the two in one
// query. So each channel gets its OWN Mode report per tab, and "All
// channels" is merged here at the app layer, not via SQL UNION.
//
// Convention: retail's report_config row uses `${baseReportType}_retail`
// as its report_type key, e.g. 'sales' (delivery) + 'sales_retail' (retail).
// Until that key exists in report_config, retail gracefully reports as
// "unavailable" rather than throwing — so this code needs ZERO changes
// once SQL Wiz's retail token is actually added; it just starts working.

const CHANNEL_REPORT_SUFFIX = { retail: '_retail' };

function channelReportType(baseReportType, channel) {
  const suffix = CHANNEL_REPORT_SUFFIX[channel];
  return suffix ? `${baseReportType}${suffix}` : baseReportType;
}

async function _tryGetData(brandName, reportType, timeframe, customStart, customEnd) {
  try {
    const result = await getData(brandName, reportType, timeframe, customStart, customEnd);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Retail's Mode query may not use identical column names to delivery's
// (e.g. `gross_receipts` instead of `gross_sales`) — SQL Wiz flagged this
// as a real possibility. Rather than let the frontend's aggregation
// silently sum `undefined` as NaN, normalize any known retail-side aliases
// to delivery's canonical names here, once, in one place. Update this map
// as soon as the real Sales (Retail) column names are confirmed — nothing
// else needs to change.
const RETAIL_FIELD_ALIASES = {
  // Confirmed by SQL Wiz — gross_sales, net_sales, units_sold already match
  // delivery's naming exactly, no alias needed for those.
  'total_discounts': 'promo_discount',
};

function _normalizeChannelFields(row, channel) {
  if (channel !== 'retail') return row;
  const normalized = { ...row };
  for (const [retailField, canonicalField] of Object.entries(RETAIL_FIELD_ALIASES)) {
    if (retailField in normalized && !(canonicalField in normalized)) {
      normalized[canonicalField] = normalized[retailField];
    }
  }
  return normalized;
}

function _tagRows(rows, channel) {
  return (rows || []).map(r => ({ ..._normalizeChannelFields(r, channel), channel }));
}

// channel: 'all' | 'delivery' | 'retail'
async function getDataForChannel(brandName, baseReportType, channel = 'all', timeframe = 'month', customStart, customEnd) {
  if (channel === 'delivery') {
    const res = await _tryGetData(brandName, baseReportType, timeframe, customStart, customEnd);
    if (!res.ok) throw new Error(res.error);
    return {
      data: { columns: res.data.columns, rows: _tagRows(res.data.rows, 'delivery') },
      source: res.source, fetchedAt: res.fetchedAt,
      channelsIncluded: ['delivery'], retailAvailable: false,
    };
  }

  if (channel === 'retail') {
    const retailType = channelReportType(baseReportType, 'retail');
    const res = await _tryGetData(brandName, retailType, timeframe, customStart, customEnd);
    if (!res.ok) {
      // Retail not wired yet — signal unavailable rather than throwing,
      // so the frontend can show a clear "coming soon" state.
      return {
        data: { columns: [], rows: [] }, source: 'unavailable', fetchedAt: null,
        channelsIncluded: [], retailAvailable: false,
      };
    }
    return {
      data: { columns: res.data.columns, rows: _tagRows(res.data.rows, 'retail') },
      source: res.source, fetchedAt: res.fetchedAt,
      channelsIncluded: ['retail'], retailAvailable: true,
    };
  }

  // channel === 'all' — fetch both in parallel, merge whatever succeeds
  const retailType = channelReportType(baseReportType, 'retail');
  const [deliveryRes, retailRes] = await Promise.all([
    _tryGetData(brandName, baseReportType, timeframe, customStart, customEnd),
    _tryGetData(brandName, retailType, timeframe, customStart, customEnd),
  ]);

  if (!deliveryRes.ok) throw new Error(deliveryRes.error); // delivery is the baseline; a real failure here should surface

  const channelsIncluded = ['delivery'];
  let rows    = _tagRows(deliveryRes.data.rows, 'delivery');
  let columns = deliveryRes.data.columns;

  if (retailRes.ok) {
    channelsIncluded.push('retail');
    rows = rows.concat(_tagRows(retailRes.data.rows, 'retail'));
    columns = Array.from(new Set([...columns, ...retailRes.data.columns]));
  }

  return {
    data: { columns, rows },
    source: deliveryRes.source,
    fetchedAt: deliveryRes.fetchedAt,
    channelsIncluded,
    retailAvailable: retailRes.ok,
  };
}

module.exports = { getData, getNarrative, refreshBrand, computeDateRange, REPORT_TYPES,
                    getDataForChannel, CHANNEL_REPORT_SUFFIX };
