-- Public pages (SPEC F-21): a product is one or more of the owner's connections, published at
-- /p/<slug> with an embeddable badge. Only instances with PUBLIC_PAGES=true serve them.
--   slug:         lowercase letters, digits and inner hyphens, 3 to 40 characters (src/lib/public-pages.ts)
--   name, tagline, website: typed by the owner; the page says so. website is an https URL or NULL
--   published_at: when the owner last published it; NULL = not public (the page is a 404)
--   stats:        PublicProductStats JSON (src/data/types.ts), worked out when a sync finishes and when
--                 the product changes, so a public request reads this one row. NULL until computed, or
--                 when no connection that counts is left
CREATE TABLE public_products (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name         TEXT NOT NULL,
  tagline      TEXT,
  website      TEXT,
  published_at INTEGER,
  stats        TEXT,
  stats_at     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX public_products_user ON public_products(user_id);

-- The connections a product adds up. A connection is in at most one product, so a profile's total
-- never counts it twice. Deleting the connection or the product removes the row.
CREATE TABLE public_product_connections (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES public_products(id) ON DELETE CASCADE
);
CREATE INDEX public_product_connections_product ON public_product_connections(product_id);
