-- A product's app store listings (SPEC F-21): one link each for the App Store and Google Play,
-- stored in their canonical form (lib/public-pages.ts normalizeAppStoreUrl / normalizePlayStoreUrl);
-- null for none. The public page links them beside the website, and without a website or an
-- uploaded logo, the App Store listing's icon becomes the product's logo.
ALTER TABLE public_products ADD COLUMN app_store_url TEXT;
ALTER TABLE public_products ADD COLUMN play_store_url TEXT;
