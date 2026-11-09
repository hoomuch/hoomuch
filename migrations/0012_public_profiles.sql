-- Founder profiles (SPEC F-22): who makes a public product. One per account, and an account needs
-- one before it can publish a product, whose page shows it. It's public exactly while at least one
-- of the owner's products is: /u/<handle> adds those up, and with none it's a 404, not a page of links.
-- Only instances with PUBLIC_PAGES=true serve it.
--   handle:       lowercase letters, digits, hyphens and underscores, 3 to 30 characters
--   display_name, bio, website, x_handle: typed by the owner; the pages say so
CREATE TABLE public_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  bio          TEXT,
  website      TEXT,
  x_handle     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
