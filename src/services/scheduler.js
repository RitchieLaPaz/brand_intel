// src/services/scheduler.js — Daily cache refresh cron
//
// Runs at 6:00 AM Pacific Time every day.
// Fetches the current month's data for all active brands and all report types.
// Uses node-cron — no external worker needed on Railway.

const cron           = require('node-cron');
const { refreshBrand, REPORT_TYPES } = require('./data');
const db             = require('../db');

// ─── Date helpers (current month window) ─────────────────────

function currentMonthWindow() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const start = `${year}-${month}-01`;
  // Last day of current month
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();
  const end     = `${year}-${month}-${lastDay}`;
  return { periodStart: start, periodEnd: end };
}

// ─── Refresh all active brands ────────────────────────────────

async function runDailyRefresh() {
  const { periodStart, periodEnd } = currentMonthWindow();
  console.log(`[cron] starting daily refresh — ${periodStart} to ${periodEnd}`);

  const brands = await db.getBrands();
  let total = 0, failed = 0;

  for (const brand of brands) {
    console.log(`[cron] refreshing ${brand.brand_name}...`);
    try {
      const results = await refreshBrand(brand.brand_id, periodStart, periodEnd);
      const fails   = (results ?? []).filter(r => !r.success);
      if (fails.length) {
        fails.forEach(f => console.warn(`  ↳ ${f.reportType} failed: ${f.error}`));
        failed += fails.length;
      }
      total += (results ?? []).length;
    } catch (err) {
      console.error(`[cron] brand ${brand.brand_id} failed entirely:`, err.message);
      failed++;
    }
  }

  console.log(`[cron] daily refresh complete — ${total - failed}/${total} reports ok`);
}

// ─── Start the cron ───────────────────────────────────────────
// '0 6 * * *' = 6:00 AM server time (set TZ=America/Los_Angeles in Railway env)

function startScheduler() {
  cron.schedule('0 6 * * *', () => {
    runDailyRefresh().catch(err => console.error('[cron] unhandled error:', err));
  }, {
    timezone: 'America/Los_Angeles',
  });

  console.log('[cron] scheduler started — daily refresh at 6:00 AM PT');

  // Optional: run once on startup if it's past 6 AM and the cache is empty
  if (process.env.REFRESH_ON_START === 'true') {
    console.log('[cron] REFRESH_ON_START=true — running initial refresh...');
    runDailyRefresh().catch(err => console.error('[cron] startup refresh error:', err));
  }
}

module.exports = { startScheduler, runDailyRefresh };
