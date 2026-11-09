-- What an owner tells visitors about a product (SPEC F-21), shown on its public page apart from
-- the verified figures and marked as the owner's words:
--   founded: when it started, 'YYYY-MM' or 'YYYY' (lib/product-details.ts parseFounded); null for none
--   country: where it's made, an ISO 3166-1 alpha-2 code in capitals (lib/countries.ts); null for none.
--            A column of its own, so Explore can filter on it
--   details: ProductDetails JSON (lib/product-details.ts): the pitch, the audience, pricing, team,
--            funding, and tags from fixed lists (market, tech stack, marketing channels); null for none
ALTER TABLE public_products ADD COLUMN founded TEXT;
ALTER TABLE public_products ADD COLUMN country TEXT;
ALTER TABLE public_products ADD COLUMN details TEXT;
