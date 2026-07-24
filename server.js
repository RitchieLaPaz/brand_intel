// server.js — Eaze Brand Intelligence
const express   = require('express');
const session   = require('express-session');
const path      = require('path');
const app       = express();
const PORT      = process.env.PORT || 3000;

// Bump this string any time you deploy, so you can confirm in DevTools
// Network tab → Response Headers → X-App-Build that the file you're LOOKING
// AT in the browser is actually the file that's running on the server.
const APP_BUILD = 'no-cache-fix-2026-07-24';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Disable caching entirely (belt AND suspenders) ───────────────
// This app is a single index.html with all JS inline. If the browser (or any
// proxy/CDN) caches that file, a deploy can silently keep serving old
// JavaScript logic indefinitely via 304 Not Modified responses.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store'); // some CDNs/edge proxies honor this specifically
  res.set('X-App-Build', APP_BUILD);        // diagnostic — check this in Network tab response headers
  // Defensively strip any conditional-cache headers that slip through from
  // static/sendFile before the response is actually flushed to the client.
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  next();
});

// ── Session ─────────────────────────────────────────────────────
// Use PostgreSQL session store if DATABASE_URL is set, else memory
let sessionStore;
try {
  const connectPg = require('connect-pg-simple');
  const { pool }  = require('./src/db');
  const PgStore   = connectPg(session);
  sessionStore    = new PgStore({ pool, createTableIfMissing: true });
} catch (e) {
  console.warn('[session] PostgreSQL store unavailable, using memory store');
}

app.use(session({
  store:             sessionStore,
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3_600_000 },
}));

// ── Google OAuth (required — no demo/open-access fallback) ──────
const GOOGLE_CONFIGURED = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;

if (!GOOGLE_CONFIGURED) {
  console.error('[auth] FATAL: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Refusing to start with open access.');
  process.exit(1);
}

const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value;
  if (!email?.endsWith(process.env.ALLOWED_EMAIL_DOMAIN || '@eaze.com')) {
    return done(null, false, { message: 'Access restricted' });
  }
  done(null, { id: profile.id, email, name: profile.displayName });
}));

passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=unauthorized' }),
  (req, res) => { req.session.user = req.user; res.redirect('/?auth=success'); }
);
console.log(`[auth] Google OAuth configured — build ${APP_BUILD}`);

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/?logout=success'); });

// ── Diagnostic endpoint — confirms which build is actually running ──
// Visit this directly in a browser to sanity-check deployment state,
// independent of any HTML/JS caching questions entirely.
app.get('/__version', (req, res) => {
  res.json({ build: APP_BUILD, time: new Date().toISOString() });
});

// ── Shared report portal ────────────────────────────────────────
app.get('/r/:token', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { etag: false, lastModified: false, cacheControl: false }));

// ── API routes ──────────────────────────────────────────────────
try {
  const apiRouter = require('./src/routes/api');
  app.use('/api', apiRouter);
  console.log('[routes] API routes mounted');
} catch (e) {
  console.error('[routes] Failed to load API routes:', e.message);
}

// ── Static frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, cacheControl: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html'), { etag: false, lastModified: false, cacheControl: false }));

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Eaze Brand Intelligence on port ${PORT} — build ${APP_BUILD}`);

  // Start cron scheduler
  try {
    const { startScheduler } = require('./src/services/scheduler');
    startScheduler();
  } catch (e) {
    console.error('[cron] Failed to start scheduler:', e.message);
  }
});
