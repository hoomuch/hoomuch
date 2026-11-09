-- Taking a public page down (SPEC F-21): the instance's operator removes a product that breaks its
-- rules (spam, scams, someone else's data). Set by hand, like hidden_at (README "Public pages").
--   removed_at: when it was taken down; NULL = not. While it's set, the page, its Markdown, its badge
--               and its history are the ordinary 404, it's off Explore, the sitemap and its founder's
--               profile, and its owner can't publish it again (the Share page says why)
ALTER TABLE public_products ADD COLUMN removed_at INTEGER;
