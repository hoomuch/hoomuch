/**
 * Snapshot warnings that code outside their adapter recognises by their exact text. They live here,
 * not in the adapter, so the dashboard's read models can match them without importing adapter code.
 */

/** Stripe: the key can't read products. The dashboard names the Stripe connections it can't split by product. */
export const STRIPE_PRODUCTS_WARNING =
  'This key can’t read product names, so MRR isn’t split by product. Add Products: Read to fix it.';
