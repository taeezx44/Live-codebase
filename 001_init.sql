-- ============================================================
-- 001_init.sql  —  PostgreSQL initial schema
--
-- Runs automatically on first `docker compose up` via
-- postgres docker-entrypoint-initdb.d mounting.
--
-- For subsequent migrations use Kysely migrator
-- (see infra/migrations/postgres/migrator.ts)
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram index for LIKE search

-- ── repos ────────────────────────────────────────────────────
-- One row per imported repository

CREATE TABLE repos (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  url             TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  branch          TEXT,
  status          TEXT        NOT NULL DEFAULT 'queued'
                              CHECK (status IN (
                                'queued','cloning','analyzing',
                                'indexing','complete','failed'
                              )),
  current_job_id  TEXT,
  -- Analysis summary (filled after complete)
  total_files     INTEGER,
  total_loc       INTEGER,
  total_functions INTEGER,
  parse_errors    INTEGER,
  -- Git metadata (filled after clone)
  commit_hash     TEXT,
  default_branch  TEXT,
  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  analyzed_at     TIMESTAMPTZ
);

CREATE INDEX repos_status_idx ON repos (status);
CREATE INDEX repos_created_at_idx ON repos (created_at DESC);

-- ── files ─────────────────────────────────────────────────────
-- One row per source file per repo (upserted on re-analysis)

CREATE TABLE files (
  repo_id         UUID        NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  file_path       TEXT        NOT NULL,
  language        TEXT        NOT NULL,
  loc             INTEGER     NOT NULL DEFAULT 0,
  complexity      INTEGER     NOT NULL DEFAULT 0,   -- max CC in file
  function_count  INTEGER     NOT NULL DEFAULT 0,
  class_count     INTEGER     NOT NULL DEFAULT 0,
  import_count    INTEGER     NOT NULL DEFAULT 0,
  export_count    INTEGER     NOT NULL DEFAULT 0,
  parse_errors    INTEGER     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (repo_id, file_path)
);

-- Indexes for common query patterns
CREATE INDEX files_repo_complexity_idx ON files (repo_id, complexity DESC);
CREATE INDEX files_repo_loc_idx        ON files (repo_id, loc DESC);
CREATE INDEX files_language_idx        ON files (repo_id, language);

-- Trigram index for fuzzy file path search (used by search-engine)
CREATE INDEX files_path_trgm_idx ON files USING GIN (file_path gin_trgm_ops);

-- ── file_symbols ──────────────────────────────────────────────
-- Exported names from each file (functions, classes, variables)
-- Used by the search index builder (index.job)

CREATE TABLE file_symbols (
  repo_id     UUID  NOT NULL,
  file_path   TEXT  NOT NULL,
  symbol_name TEXT  NOT NULL,
  kind        TEXT  NOT NULL CHECK (kind IN ('function','class','variable','type')),

  PRIMARY KEY (repo_id, file_path, symbol_name),
  FOREIGN KEY (repo_id, file_path) REFERENCES files(repo_id, file_path) ON DELETE CASCADE
);

CREATE INDEX file_symbols_name_idx ON file_symbols USING GIN (symbol_name gin_trgm_ops);

-- ── repo_jobs ─────────────────────────────────────────────────
-- Audit log of all analysis jobs for a repo

CREATE TABLE repo_jobs (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id     UUID        NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  bullmq_id   TEXT        NOT NULL UNIQUE,
  status      TEXT        NOT NULL DEFAULT 'queued',
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_msg   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX repo_jobs_repo_idx ON repo_jobs (repo_id, created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────
-- Auto-update updated_at on any row change

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER repos_updated_at
  BEFORE UPDATE ON repos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
