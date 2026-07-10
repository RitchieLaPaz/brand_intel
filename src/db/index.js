// src/db/index.js — PostgreSQL pool + cache helpers
const { Pool } = require('pg');
const crypto   = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});
pool.on('error', err => console.error('[db] pool error', err));

function cacheKey(brandName, reportType, startDate, endDate) {
  return crypto.createHash('md5')
    .update(`${brandName}|${reportType}|${startDate}|${endDate}`)
    .digest('hex');
}

async function getCached(brandName, reportType, startDate, endDate) {
  const key = cacheKey(brandName, reportType, startDate, endDate);
  const { rows } = await pool.query(
    `SELECT data, fetched_at, expires_at FROM query_cache WHERE cache_key = $1`, [key]
  );
  if (!rows.length) return null;
  return { data: rows[0].data, fetchedAt: rows[0].fetched_at, expiresAt: rows[0].expires_at,
           isStale: new Date(rows[0].expires_at) < new Date() };
}

async function setCache(brandName, reportType, startDate, endDate, timeframe, data, ttlHours = 24) {
  const key       = cacheKey(brandName, reportType, startDate, endDate);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await pool.query(
    `INSERT INTO query_cache (cache_key, brand_id, report_type, period_start, period_end, channel, data, row_count, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (cache_key) DO UPDATE
           SET data=EXCLUDED.data, row_count=EXCLUDED.row_count,
               fetched_at=NOW(), expires_at=EXCLUDED.expires_at`,
    [key, brandName, reportType, startDate, endDate, timeframe,
     JSON.stringify(data), data?.rows?.length ?? null, expiresAt]
  );
}

async function getNarrative(brandName, reportType) {
  const { rows } = await pool.query(
    `SELECT narrative FROM ai_narratives
      WHERE brand_id=$1 AND report_type=$2 AND expires_at > NOW()
      ORDER BY generated_at DESC LIMIT 1`,
    [brandName, reportType]
  );
  return rows[0]?.narrative ?? null;
}

async function setNarrative(brandName, reportType, narrative, tokensUsed, ttlHours = 24) {
  const key       = cacheKey(brandName, reportType, 'narrative', 'narrative');
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await pool.query(
    `INSERT INTO ai_narratives (cache_key, brand_id, report_type, narrative, tokens_used, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (cache_key) DO UPDATE
           SET narrative=EXCLUDED.narrative, tokens_used=EXCLUDED.tokens_used,
               generated_at=NOW(), expires_at=EXCLUDED.expires_at`,
    [key, brandName, reportType, narrative, tokensUsed, expiresAt]
  );
}

async function getBrands() {
  const { rows } = await pool.query(
    `SELECT brand_id, brand_name, brand_color, mode_reports
       FROM brands WHERE is_active=TRUE
      ORDER BY CASE WHEN brand_name = 'Jeeter' THEN 0 ELSE 1 END, brand_name`
  );
  return rows;
}

// Lookup by canonical name (used by data.js)
async function getBrandByName(brandName) {
  const { rows } = await pool.query(
    `SELECT * FROM brands WHERE brand_name=$1 AND is_active=TRUE`, [brandName]
  );
  return rows[0] ?? null;
}

async function logApiCall(brandName, reportType, source, modeToken, responseMs, success, errorMsg = null) {
  await pool.query(
    `INSERT INTO api_calls (brand_id, report_type, source, mode_report_token, response_ms, success, error_message)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [brandName, reportType, source, modeToken, responseMs, success, errorMsg]
  ).catch(err => console.error('[db] audit log error', err));
}

module.exports = { pool, getCached, setCache, getNarrative, setNarrative,
                   getBrands, getBrandByName, logApiCall };
