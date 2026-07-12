# Brand Analytics Platform

A brand performance analytics dashboard that pulls live data from a BI layer (Mode Analytics) backed by Redshift, with a Node.js/Express backend and a vanilla JS frontend. No build step required.

## What it does

- **Live Sales tab** — fetches real transaction data for any brand, aggregates it client-side by day/week/month, and renders KPIs, a trend chart, and a breakdown table
- **529 brands supported out of the box** — report queries are parameterized by brand name, so no per-brand configuration is needed
- **Flexible timeframes** — Current Day, Yesterday, Current Week, Last Week, MTD, Last Month, Quarter, YTD, and Custom date range
- **Manual refresh** — force a fresh pull from the BI layer, bypassing cache, when you need the latest numbers immediately
- **Stale-while-revalidate caching** — cached results return instantly; stale entries refresh in the background so the UI never blocks
- **Tokenized report sharing** — generate a read-only, expiring link to a brand's report for external stakeholders
- **State persistence** — refreshing the page returns you to the same screen, tab, brand, and timeframe you were viewing

## Screens

- **Login** — Google OAuth (optional; runs in demo mode without it configured)
- **Dashboard** — multi-tab analytics tool with brand selector, timeframe/granularity controls, and live charts
- **Report portal** — read-only branded view for external stakeholders via tokenized links

## Architecture

```
BI layer (SQL reports, parameterized by brand + date range)
        ↓
Node.js/Express backend  →  PostgreSQL (cache, sessions, share tokens)
        ↓
Dashboard (vanilla JS, fetch-based, Chart.js visualizations)
```

Report tokens are configured **globally** (one per report type, e.g. Sales/Inventory/Promo), not per-brand — the BI layer's SQL is parameterized by brand name, so the same report serves every brand.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your own credentials — see below
npm start
# open http://localhost:3000
```

## Environment variables

See `.env.example` for the full list. You'll need to provide your own:
- A PostgreSQL connection string (for caching, sessions, and share tokens)
- BI layer API credentials and workspace identifier
- Google OAuth credentials (optional — omit to run in demo mode)
- A session secret (any long random string)

**Never commit a `.env` file or real credentials to this repository.** `.gitignore` already excludes `.env`.

## Deploy to Railway

1. Push this repo to GitHub
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub → select repo
3. Add a PostgreSQL plugin to the project; link its `DATABASE_URL` to this service via a Variable Reference
4. Set the remaining environment variables from `.env.example` in the Railway service's Variables tab
5. Run `src/db/schema.sql` once against the provisioned PostgreSQL database to create the required tables

## Project structure

```
index.html                    Frontend — dashboard, login, report portal
server.js                     Express entry point, sessions, OAuth, routing
src/
  db/
    index.js                  PostgreSQL connection + cache helpers
    schema.sql                Database schema
  routes/
    api.js                    REST API endpoints
  services/
    mode.js                   BI layer API client
    data.js                   Cache orchestration, date-range computation
    anthropic.js              AI-generated narrative insights
    scheduler.js              Daily cache refresh cron job
```

## Stack

- Vanilla HTML / CSS / JS — zero build step
- [Express.js](https://expressjs.com/) — backend server
- [PostgreSQL](https://www.postgresql.org/) — caching, sessions, share tokens
- [Chart.js 4.4.1](https://www.chartjs.org/) (CDN) — data visualization
- [Tabler Icons](https://tabler-icons.io/) (CDN)
- [node-cron](https://www.npmjs.com/package/node-cron) — scheduled cache refresh
- [Passport.js](https://www.passportjs.org/) — Google OAuth (optional)

## Status

Sales tab is live and verified against source data. Additional report tabs (Inventory, Promo, and others) are being wired incrementally — see project tracking for current status.
