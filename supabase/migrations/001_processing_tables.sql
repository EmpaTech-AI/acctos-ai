-- IMPORTANT: Also create a Supabase Storage bucket named "processed-files"
-- (private, no public access) via the Supabase dashboard → Storage → New bucket.

-- Azure DI cache: avoids re-calling Azure for PDFs already processed
CREATE TABLE IF NOT EXISTS azure_di_cache (
    file_hash   TEXT        PRIMARY KEY,  -- SHA-256 of the raw PDF buffer
    filename    TEXT        NOT NULL,
    pages       JSONB       NOT NULL,     -- Array<{ cells: Cell[], content: string } | null>
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Processing jobs: persistent record of all jobs (single and batch)
CREATE TABLE IF NOT EXISTS processing_jobs (
    id                TEXT        PRIMARY KEY,
    filename          TEXT        NOT NULL,
    bank_type         TEXT,
    processing_mode   TEXT        NOT NULL DEFAULT 'bank_statement',
    status            TEXT        NOT NULL DEFAULT 'queued',
    transaction_count INT,
    error             TEXT,
    error_type        TEXT,
    output_path       TEXT,       -- path in Supabase Storage bucket "processed-files"
    created_at        TIMESTAMPTZ DEFAULT now(),
    completed_at      TIMESTAMPTZ
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS processing_jobs_created_at ON processing_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS processing_jobs_status     ON processing_jobs (status);
