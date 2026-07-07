-- ─────────────────────────────────────────────────────────────
-- Eaze Brand Intelligence · Railway PostgreSQL schema
-- Run once after provisioning: psql $DATABASE_URL < schema.sql
-- ─────────────────────────────────────────────────────────────

-- Brand registry
-- mode_reports maps tab name → Mode report token, e.g.
-- { "sales": "abc123", "promo": "def456", ... }
CREATE TABLE IF NOT EXISTS brands (
  id           SERIAL PRIMARY KEY,
  brand_id     VARCHAR(100) UNIQUE NOT NULL,
  brand_name   VARCHAR(200) NOT NULL,
  brand_color  VARCHAR(7) DEFAULT '#888888',
  mode_reports JSONB NOT NULL DEFAULT '{}',
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Mode query result cache
-- cache_key = md5(brand_id + report_type + period_start + period_end + channel)
CREATE TABLE IF NOT EXISTS query_cache (
  id           SERIAL PRIMARY KEY,
  cache_key    VARCHAR(64) UNIQUE NOT NULL,
  brand_id     VARCHAR(100) NOT NULL,
  report_type  VARCHAR(50)  NOT NULL,
  period_start DATE         NOT NULL,
  period_end   DATE         NOT NULL,
  channel      VARCHAR(20)  NOT NULL DEFAULT 'all',
  data         JSONB        NOT NULL,
  row_count    INTEGER,
  fetched_at   TIMESTAMPTZ  DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_brand_report
  ON query_cache (brand_id, report_type, expires_at);

-- Anthropic narrative cache (regenerated when data changes or weekly)
CREATE TABLE IF NOT EXISTS ai_narratives (
  id           SERIAL PRIMARY KEY,
  cache_key    VARCHAR(64) UNIQUE NOT NULL,
  brand_id     VARCHAR(100) NOT NULL,
  report_type  VARCHAR(50)  NOT NULL,
  narrative    TEXT         NOT NULL,
  tokens_used  INTEGER,
  generated_at TIMESTAMPTZ  DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  NOT NULL
);

-- Tokenized share links for client-facing report portal
CREATE TABLE IF NOT EXISTS share_tokens (
  id           SERIAL PRIMARY KEY,
  token        VARCHAR(32)  UNIQUE NOT NULL,
  brand_id     VARCHAR(100) NOT NULL,
  modules      TEXT[]       NOT NULL DEFAULT '{}',
  created_by   VARCHAR(200),
  expires_at   TIMESTAMPTZ,
  last_viewed  TIMESTAMPTZ,
  view_count   INTEGER DEFAULT 0,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_token
  ON share_tokens (token) WHERE is_active = TRUE;

-- API call audit log (Mode + Anthropic usage tracking)
CREATE TABLE IF NOT EXISTS api_calls (
  id               SERIAL PRIMARY KEY,
  brand_id         VARCHAR(100),
  report_type      VARCHAR(50),
  source           VARCHAR(20) NOT NULL, -- 'mode' | 'anthropic' | 'cache'
  mode_report_token VARCHAR(50),
  response_ms      INTEGER,
  success          BOOLEAN NOT NULL,
  error_message    TEXT,
  called_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_calls_called_at
  ON api_calls (called_at DESC);

-- Seed: add your brands here after running the schema
-- UPDATE brands SET mode_reports = '{"sales":"<token>","promo":"<token>","products":"<token>","inventory":"<token>","tdp":"<token>","rankings":"<token>","pricing":"<token>","orders":"<token>","campaigns":"<token>"}' WHERE brand_id = 'habitat';

INSERT INTO brands (brand_id, brand_name, brand_color) VALUES
  ('jeeter',             'Jeeter',            '#F59E0B'),
  ('habitat',            'Habitat',           '#4CAF50'),
  ('circles-base-camp',  'Circles Base Camp', '#2196F3'),
  ('cloud',              'Cloud',             '#9C27B0'),
  ('everyday',           'Everyday',          '#FF7043'),
  ('anarchy',            'Anarchy',           '#E53935'),
  ('circles-eclipse',    'Circles Eclipse',   '#607D8B')
ON CONFLICT (brand_id) DO NOTHING;
