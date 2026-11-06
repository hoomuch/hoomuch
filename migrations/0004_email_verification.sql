-- Email verification (SPEC.md §8). Only enforced while RESEND_API_KEY is set.
-- email_verified_at: when the owner confirmed the address through a mailed link (epoch ms).
-- NULL means never confirmed.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

-- Accounts that predate verification keep working as they did: count them as confirmed.
UPDATE users SET email_verified_at = created_at;

-- Single-use confirmation links. id = sha256(token) hex; the raw token only lives in the mailed
-- link. A link is spent by deleting its row; confirming removes every row of that user.
CREATE TABLE email_verifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);
