CREATE TABLE IF NOT EXISTS tenants (
  slug           TEXT PRIMARY KEY,
  platform       TEXT,            -- career-next | career-embedded | board
  host           TEXT,
  custom_domain  TEXT,            -- customer's own branded domain, via redirect
  company_name   TEXT,
  locale         TEXT,
  user_id        TEXT,            -- widget ids (career stacks only)
  project_id     TEXT,
  page_id        TEXT,
  seen_on        TEXT,            -- which softgarden domain(s) Common Crawl saw
  feed_available INTEGER,
  live           INTEGER NOT NULL DEFAULT 0,
  detail_host    TEXT,          -- board host that actually serves this tenant's job pages
  note           TEXT,
  first_seen     TEXT NOT NULL,
  last_checked   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  tenant_slug      TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  job_id           TEXT NOT NULL,
  url              TEXT,
  title            TEXT,
  description_html TEXT,
  description_text TEXT,
  date_posted      TEXT,
  valid_through    TEXT,
  employment_type  TEXT,
  career_level     TEXT,
  work_experience  TEXT,
  work_time        TEXT,
  remote_status    TEXT,
  remote_key       TEXT,
  salary           TEXT,
  city             TEXT,
  region           TEXT,
  country          TEXT,          -- ISO-3166-1 alpha-2
  postal_code      TEXT,
  street_address   TEXT,
  lat              REAL,
  lng              REAL,
  categories       TEXT,          -- JSON array
  company_name     TEXT,
  apply_url        TEXT,
  version_id       INTEGER,       -- exact change signal on the career stack
  content_hash     TEXT,          -- change signal where version_id is absent
  is_open          INTEGER NOT NULL DEFAULT 1,
  detail_ok        INTEGER NOT NULL DEFAULT 0,
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  detail_note      TEXT,          -- why a detail fetch failed; NULL when it succeeded
  closed_at        TEXT,
  PRIMARY KEY (tenant_slug, job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_open    ON jobs(is_open);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant  ON jobs(tenant_slug, is_open);
CREATE INDEX IF NOT EXISTS idx_jobs_country ON jobs(country);
CREATE INDEX IF NOT EXISTS idx_jobs_posted  ON jobs(date_posted);
CREATE INDEX IF NOT EXISTS idx_jobs_detail  ON jobs(is_open, detail_ok);

-- One row per crawl run, for observability.
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mode          TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ok            INTEGER,
  tenants_seen  INTEGER DEFAULT 0,
  tenants_live  INTEGER DEFAULT 0,
  jobs_seen     INTEGER DEFAULT 0,
  jobs_new      INTEGER DEFAULT 0,
  jobs_updated  INTEGER DEFAULT 0,
  jobs_closed   INTEGER DEFAULT 0,
  details_ok    INTEGER DEFAULT 0,
  errors        TEXT
);

-- Per-run job counts, so a sudden drop is detectable.
CREATE TABLE IF NOT EXISTS tenant_snapshots (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_slug TEXT NOT NULL,
  job_count   INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tenant_slug)
);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  tenant_slug TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
