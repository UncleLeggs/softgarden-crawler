-- Mirrors schema.sqlite.sql. Boolean-ish columns stay SMALLINT so the 0/1
-- values the shared queries pass work on both backends unchanged. Timestamps
-- stay TEXT (ISO-8601, produced in JS) so comparisons and exports are identical
-- across backends; convert in SQL at read time if you need interval maths.

CREATE TABLE IF NOT EXISTS tenants (
  slug           TEXT PRIMARY KEY,
  platform       TEXT,
  host           TEXT,
  custom_domain  TEXT,
  company_name   TEXT,
  locale         TEXT,
  user_id        TEXT,
  project_id     TEXT,
  page_id        TEXT,
  seen_on        TEXT,
  feed_available SMALLINT,
  live           SMALLINT NOT NULL DEFAULT 0,
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
  country          TEXT,
  postal_code      TEXT,
  street_address   TEXT,
  lat              DOUBLE PRECISION,
  lng              DOUBLE PRECISION,
  categories       TEXT,
  company_name     TEXT,
  apply_url        TEXT,
  version_id       BIGINT,
  content_hash     TEXT,
  is_open          SMALLINT NOT NULL DEFAULT 1,
  detail_ok        SMALLINT NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS runs (
  id            BIGSERIAL PRIMARY KEY,
  mode          TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ok            SMALLINT,
  tenants_seen  INTEGER DEFAULT 0,
  tenants_live  INTEGER DEFAULT 0,
  jobs_seen     INTEGER DEFAULT 0,
  jobs_new      INTEGER DEFAULT 0,
  jobs_updated  INTEGER DEFAULT 0,
  jobs_closed   INTEGER DEFAULT 0,
  details_ok    INTEGER DEFAULT 0,
  errors        TEXT
);

CREATE TABLE IF NOT EXISTS tenant_snapshots (
  run_id      BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tenant_slug TEXT NOT NULL,
  job_count   INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tenant_slug)
);

CREATE TABLE IF NOT EXISTS alerts (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT REFERENCES runs(id) ON DELETE CASCADE,
  tenant_slug TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
