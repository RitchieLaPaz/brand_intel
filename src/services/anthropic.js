// src/services/anthropic.js — Narrative insight generation
//
// Each dashboard tab gets a concise 2-3 sentence insight generated from its
// data. Insights are cached in PostgreSQL for 24h to minimize API calls.
//
// Prompt philosophy:
//   - Pass structured data (KPIs + top rows), not raw dumps
//   - Ask for actionable, brand-specific language
//   - Keep output short — these appear as callout cards in the UI

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-6';

// ─── Prompt templates per report type ────────────────────────

const PROMPTS = {
  sales: ({ brand, period, kpis, rows }) =>
    `You are a cannabis brand analyst. Write 2 sentences summarizing ${brand}'s sales performance for ${period}.
Data: Gross sales ${kpis.grossSales}, Net sales ${kpis.netSales}, Units ${kpis.units}, Avg discount ${kpis.avgDiscount}.
Weekly trend: ${JSON.stringify(rows.slice(0, 4))}.
Focus on the most notable trend (growth, dip, or anomaly). Be specific and direct. No fluff.`,

  promo: ({ brand, period, kpis }) =>
    `Write 2 sentences on ${brand}'s promo performance for ${period}.
Promo units: ${kpis.promoUnits}, Promo credit: ${kpis.promoCredit}, DNE contribution: ${kpis.dneContribution}, % of total units: ${kpis.promoPercent}.
Note whether promo reliance is rising or falling and what that signals for margin.`,

  products: ({ brand, period, rows }) =>
    `Write 2 sentences on ${brand}'s SKU mix for ${period}.
Top SKUs by net sales: ${JSON.stringify(rows.slice(0, 5).map(r => ({ sku: r.sku_name, net: r.net_sales, disc: r.discount_pct })))}.
Highlight which SKU is driving revenue and flag any discount health concern.`,

  inventory: ({ brand, period, kpis, rows }) =>
    `Write 2 sentences on ${brand}'s inventory health for ${period}.
Avg DOS: ${kpis.avgDos} days. At-risk SKUs (<7 DOS): ${kpis.atRisk}. Overstock (>45 DOS): ${kpis.overstock}.
Name the most urgent reorder location/SKU if applicable. Keep it actionable.`,

  tdp: ({ brand, period, kpis }) =>
    `Write 1-2 sentences on ${brand}'s distribution health for ${period}.
Overall TDP: ${kpis.overallTdp}%, full distribution SKUs: ${kpis.fullDist}, SKUs below 50%: ${kpis.below50}.
Flag the biggest distribution gap opportunity.`,

  rankings: ({ brand, period, kpis }) =>
    `Write 2 sentences on ${brand}'s market position on the Eaze platform for ${period}.
Preroll rank: #${kpis.prerollRank}, Flower rank: #${kpis.flowerRank}, Platform rank: #${kpis.platformRank}, Category share: ${kpis.categoryShare}%.
Note any rank movement and what it suggests competitively.`,

  pricing: ({ brand, period, kpis }) =>
    `Write 2 sentences on ${brand}'s pricing health for ${period}.
Avg SRP: ${kpis.avgSrp}, Avg actual: ${kpis.avgActual}, Promo depth: ${kpis.promoDepth}%, SKUs at full SRP: ${kpis.atFullSrp}.
Flag whether discount pressure is worsening and which SKUs need attention.`,

  campaigns: ({ brand, period, kpis }) =>
    `Write 2 sentences on ${brand}'s promo campaign performance for ${period}.
Active campaigns: ${kpis.activeCampaigns}, Total spend: ${kpis.totalSpend}, Avg lift: ${kpis.avgLift}%.
Highlight the best-performing campaign and whether overall ROI is trending positively.`,
};

// ─── Extract KPIs from Mode result rows ──────────────────────
// These functions transform raw Mode result rows into the KPI objects
// the prompt templates expect. Adjust field names to match your actual schema.

function extractKpis(reportType, rows) {
  if (!rows || !rows.length) return {};
  const r = rows[0]; // first row often has summary-level KPIs in the Mode query

  switch (reportType) {
    case 'sales':
      return {
        grossSales:  r.gross_sales ?? r.total_gross_sales,
        netSales:    r.net_sales   ?? r.total_net_sales,
        units:       r.units_sold  ?? r.total_units,
        avgDiscount: r.avg_discount_pct ?? r.discount_rate,
      };
    case 'promo':
      return {
        promoUnits:     r.promo_units,
        promoCredit:    r.promo_credit,
        dneContribution: r.dne_contribution,
        promoPercent:   r.promo_pct_of_units,
      };
    case 'inventory':
      return {
        avgDos:    r.avg_dos,
        atRisk:    r.at_risk_count,
        overstock: r.overstock_count,
      };
    case 'tdp':
      return {
        overallTdp: r.overall_tdp_pct,
        fullDist:   r.full_distribution_skus,
        below50:    r.below_50_pct_skus,
      };
    case 'rankings':
      return {
        prerollRank:   r.preroll_rank,
        flowerRank:    r.flower_rank,
        platformRank:  r.platform_rank,
        categoryShare: r.category_share_pct,
      };
    case 'pricing':
      return {
        avgSrp:      r.avg_srp,
        avgActual:   r.avg_actual_price,
        promoDepth:  r.promo_discount_depth_pct,
        atFullSrp:   r.skus_at_full_srp,
      };
    case 'campaigns':
      return {
        activeCampaigns: r.active_campaigns,
        totalSpend:      r.total_promo_spend,
        avgLift:         r.avg_sales_lift_pct,
      };
    default:
      return {};
  }
}

// ─── Generate a narrative ─────────────────────────────────────

async function generateNarrative(brand, reportType, period, rows = []) {
  const promptFn = PROMPTS[reportType];
  if (!promptFn) return null;

  const kpis    = extractKpis(reportType, rows);
  const prompt  = promptFn({ brand, period, kpis, rows });

  const message = await client.messages.create({
    model:      MODEL,
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text       = message.content[0]?.text?.trim() ?? '';
  const tokensUsed = message.usage?.input_tokens + message.usage?.output_tokens;
  return { text, tokensUsed };
}

module.exports = { generateNarrative, extractKpis };
