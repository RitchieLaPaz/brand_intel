// src/routes/api.js — REST API routes
// GET /api/brands
// GET /api/data/:brandName/:reportType?timeframe=month[&start_date=&end_date=]
// POST /api/data/:brandName/:reportType/refresh
// GET /api/narrative/:brandName/:reportType?timeframe=month
// POST /api/share
// GET /api/share/:token

const router = require('express').Router();
const { pool, getBrands } = require('../db');
const { getData, getNarrative, getDataForChannel } = require('../services/data');
const crypto = require('crypto');

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── GET /api/session ──────────────────────────────────────────
// Public endpoint (no requireAuth) — lets the frontend check real server-side
// auth state before trusting any client-side saved screen/tab state.
router.get('/session', (req, res) => {
  if (req.session?.user) {
    res.json({
      authenticated: true,
      email: req.session.user.email,
      name:  req.session.user.name || req.session.user.email,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── GET /api/brands ──────────────────────────────────────────
router.get('/brands', requireAuth, async (req, res) => {
  try {
    const brands = await getBrands();
    res.json(brands.map(b => ({
      brand_name:  b.brand_name,
      brand_color: b.brand_color,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/data/:brandName/:reportType ─────────────────────
// Query params: timeframe, start_date (custom only), end_date (custom only)
// Example: GET /api/data/Jeeter/sales?timeframe=month
// Example: GET /api/data/Jeeter/sales?timeframe=custom&start_date=2026-06-01&end_date=2026-06-30

router.get('/data/:brandName/:reportType', requireAuth, async (req, res) => {
  const { brandName, reportType } = req.params;
  const { timeframe = 'month', start_date, end_date, channel = 'all' } = req.query;

  if (timeframe === 'custom' && (!start_date || !end_date)) {
    return res.status(400).json({ error: 'custom timeframe requires start_date and end_date (YYYY-MM-DD)' });
  }
  if (!['all', 'delivery', 'retail'].includes(channel)) {
    return res.status(400).json({ error: "channel must be 'all', 'delivery', or 'retail'" });
  }

  try {
    const result = await getDataForChannel(brandName, reportType, channel, timeframe, start_date, end_date);
    res.json({
      brand_name:        brandName,
      report_type:       reportType,
      timeframe,
      channel,
      source:             result.source,
      fetched_at:         result.fetchedAt,
      channels_included:  result.channelsIncluded,
      retail_available:   result.retailAvailable,
      columns:            result.data?.columns ?? [],
      rows:               result.data?.rows    ?? [],
      row_count:          result.data?.rows?.length ?? 0,
    });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── POST /api/data/:brandName/:reportType/refresh ────────────
router.post('/data/:brandName/:reportType/refresh', requireAuth, async (req, res) => {
  const { brandName, reportType } = req.params;
  const { timeframe = 'month', start_date, end_date, channel = 'all' } = req.body;
  try {
    // Clear both delivery and retail cache entries — harmless if retail's
    // report_type row doesn't exist yet, and keeps refresh correct once it does.
    await pool.query(
      `DELETE FROM query_cache WHERE brand_id = $1 AND report_type IN ($2, $3)`,
      [brandName, reportType, `${reportType}_retail`]
    );
    const result = await getDataForChannel(brandName, reportType, channel, timeframe, start_date, end_date);
    res.json({ success: true, source: result.source, row_count: result.data?.rows?.length ?? 0,
               channels_included: result.channelsIncluded, retail_available: result.retailAvailable });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/narrative/:brandName/:reportType ────────────────
router.get('/narrative/:brandName/:reportType', requireAuth, async (req, res) => {
  const { brandName, reportType } = req.params;
  const { timeframe = 'month', start_date, end_date } = req.query;
  try {
    const narrative = await getNarrative(brandName, reportType, timeframe, start_date, end_date);
    res.json({ brand_name: brandName, report_type: reportType, ...narrative });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/share ──────────────────────────────────────────
router.post('/share', requireAuth, async (req, res) => {
  const { brand_name, modules = [], expires_days = 7 } = req.body;
  if (!brand_name) return res.status(400).json({ error: 'brand_name required' });
  const token     = crypto.randomBytes(16).toString('hex');
  const expiresAt = expires_days ? new Date(Date.now() + expires_days * 86_400_000) : null;
  try {
    await pool.query(
      `INSERT INTO share_tokens (token, brand_id, modules, created_by, expires_at)
            VALUES ($1, $2, $3, $4, $5)`,
      [token, brand_name, modules, req.session.user?.email, expiresAt]
    );
    const url = `${process.env.APP_URL || 'http://localhost:3000'}/r/${token}`;
    res.json({ token, url, expires_at: expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/share/:token ────────────────────────────────────
router.get('/share/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT brand_id, modules, expires_at FROM share_tokens
        WHERE token = $1 AND is_active = TRUE
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    await pool.query(
      `UPDATE share_tokens SET view_count = view_count + 1, last_viewed = NOW() WHERE token = $1`,
      [req.params.token]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
