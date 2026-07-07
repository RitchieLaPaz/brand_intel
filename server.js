// server.js — Eaze Brand Intelligence
const express   = require('express');
const session   = require('express-session');
const path      = require('path');
const app       = express();
const PORT      = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

// ── Google OAuth (only if credentials are configured) ───────────
const GOOGLE_CONFIGURED = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;

if (GOOGLE_CONFIGURED) {
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
    (req, res) => { req.session.user = req.user; res.redirect('/'); }
  );
  console.log('[auth] Google OAuth configured');
} else {
  // No OAuth — auto-set a demo session so API routes are accessible
  app.use((req, res, next) => {
    if (!req.session.user) {
      req.session.user = { email: 'demo@eaze.com', name: 'Demo User' };
    }
    next();
  });
  console.warn('[auth] GOOGLE_CLIENT_ID not set — running in demo mode (no auth)');
}

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── Shared report portal ────────────────────────────────────────
app.get('/r/:token', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── API routes ──────────────────────────────────────────────────
try {
  const apiRouter = require('./src/routes/api');
  app.use('/api', apiRouter);
  console.log('[routes] API routes mounted');
} catch (e) {
  console.error('[routes] Failed to load API routes:', e.message);
}

// ── Static frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Eaze Brand Intelligence on port ${PORT}`);

  // Start cron scheduler
  try {
    const { startScheduler } = require('./src/services/scheduler');
    startScheduler();
  } catch (e) {
    console.error('[cron] Failed to start scheduler:', e.message);
  }
});
