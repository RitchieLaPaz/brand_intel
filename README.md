# Brand Analytics Platform — UI Mockup

A multi-screen interactive HTML demo for a brand performance analytics platform. No backend, no build step — one HTML file served via Express.

## Screens

- **Login** — animated brand sparklines + OAuth sign-in flow (demo mode available, no credentials needed)
- **Dashboard** — 10-module analytics tool with brand selector, channel filters, and Chart.js visualizations
- **Report portal** — read-only branded report view for external stakeholders

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy to Railway

1. Push this folder to a GitHub repo
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub → select repo
3. Railway detects Node.js and runs `npm start` automatically — live in ~60 seconds

## Demo navigation

| From | Action | To |
|---|---|---|
| Login | Either sign-in button | Dashboard |
| Dashboard | User menu → Sign out | Login |
| Dashboard | Share panel → click report link | Report portal |
| Report portal | ← Back button | Dashboard |

## Stack

- Vanilla HTML / CSS / JS — zero build step
- [Chart.js 4.4.1](https://www.chartjs.org/) (CDN)
- [Tabler Icons](https://tabler-icons.io/) (CDN)
- [Express.js](https://expressjs.com/) (static file server)
