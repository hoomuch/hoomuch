-- Syncs run through a Cloudflare Queue (wrangler.jsonc `queues`). queued_at is when a sync was last
-- put on the queue for this connection and hasn't started yet: the cron doesn't queue it again, and
-- "Sync now" doesn't add a second one. Taking the sync lock clears it. NULL = nothing waiting.
ALTER TABLE connections ADD COLUMN queued_at INTEGER;
