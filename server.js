// server.js — Eaze Brand Intelligence · main entry point
const express        = require('express');
const session        = require('express-session');
const connectPg      = require('connect-pg-simple');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path           = require('path');
const { pool }       = require('./src/db');
const apiRouter      = require('./src/routes/api');
const { startScheduler } = require('./src/services/scheduler');

const app   = express();
const PORT  = process.env.PORT || 3000;
const PgStore = connectPg(session);

// ── Session (PostgreSQL-backed) ─────────────────────────────────
app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 8 * 3_600_000 },
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Google OAuth ────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  `${process.env.APP_URL}/auth/google/callback`,
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value;
  if (!email?.endsWith(process.env.ALLOWED_EMAIL_DOMAIN || '@eaze.com')) {
    return done(null, false, { message: 'Access restricted' });
  }
  done(null, { id: profile.id, email, name: profile.displayName });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes ─────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile','email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=unauthorized' }),
  (req, res) => { req.session.user = req.user; res.redirect('/'); }
);
app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ── Shared report portal (token-gated, no auth required) ────────
app.get('/r/:token', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── API ─────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Static frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Eaze Brand Intelligence on port ${PORT}`);
  startScheduler();
});
