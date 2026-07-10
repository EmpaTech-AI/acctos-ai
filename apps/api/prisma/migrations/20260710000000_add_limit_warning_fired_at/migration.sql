-- Add limitWarningFiredAt to Tenant
-- Tracks when the low-limit webhook was last fired so it fires only once per billing period.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "limitWarningFiredAt" TIMESTAMP(3);
