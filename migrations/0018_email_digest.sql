-- The email digest (SPEC F-25): a Monday morning mail with last week's numbers. Off until the owner turns it on in Settings, and only on instances that send mail
-- (RESEND_API_KEY).
--   digest:          off | weekly
--   digest_next_at:  when the next one is due (epoch ms): 08:00 in the user's time zone. NULL while
--                    off. The cron reads the due ones through idx_users_digest_due.
--   digest_sent_day: the user's local day the last one went out on, so a message the queue delivers
--                    twice is mailed once.
--   digest_origin:   the instance's own address when it was turned on (https://example.com), for
--                    the links in the mail: the cron that sends it has no request to read it from.
ALTER TABLE users ADD COLUMN digest TEXT NOT NULL DEFAULT 'off' CHECK (digest IN ('off', 'weekly'));
ALTER TABLE users ADD COLUMN digest_next_at INTEGER;
ALTER TABLE users ADD COLUMN digest_sent_day TEXT;
ALTER TABLE users ADD COLUMN digest_origin TEXT;
CREATE INDEX idx_users_digest_due ON users(digest_next_at) WHERE digest_next_at IS NOT NULL;
