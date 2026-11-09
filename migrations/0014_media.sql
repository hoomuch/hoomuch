-- Images on public pages (SPEC F-21/F-22): a founder's photo and a product's logo. The bytes live
-- in R2 (the optional MEDIA binding) under a random key; these columns hold the key, null for
-- none (the page shows initials then). logo_source says where a logo came from: 'site' (the
-- product website's icon, fetched by hoomuch) or 'upload' (the owner's own), so a new website
-- refreshes a fetched icon but never replaces an uploaded logo.
ALTER TABLE public_profiles ADD COLUMN avatar_key TEXT;
ALTER TABLE public_products ADD COLUMN logo_key TEXT;
ALTER TABLE public_products ADD COLUMN logo_source TEXT;
