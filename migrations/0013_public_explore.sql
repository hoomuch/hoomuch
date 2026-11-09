-- Explore (SPEC F-23): the gallery of published products at /explore and on the landing page.
--   listed:       the owner's choice to show the product there (on by default); its page and badge
--                 are public either way
--   hidden_at:    when the instance's operator took it off Explore (spam, a name that breaks the
--                 rules); NULL = not hidden. Set by hand, see README "Public pages"
--   mrr_usd, growth_pct, synced_at, history_from: copies of the stored figures (stats) that
--                 Explore sorts and filters on, written with them
ALTER TABLE public_products ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public_products ADD COLUMN hidden_at INTEGER;
ALTER TABLE public_products ADD COLUMN mrr_usd INTEGER;
ALTER TABLE public_products ADD COLUMN growth_pct REAL;
ALTER TABLE public_products ADD COLUMN synced_at INTEGER;
ALTER TABLE public_products ADD COLUMN history_from TEXT;
-- Explore's candidates, biggest MRR first: published, listed, not hidden.
CREATE INDEX public_products_explore ON public_products(mrr_usd DESC)
  WHERE published_at IS NOT NULL AND listed = 1 AND hidden_at IS NULL;
