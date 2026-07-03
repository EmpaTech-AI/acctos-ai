-- Add summary column to store verification results and VAT stats per job
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS summary JSONB;
