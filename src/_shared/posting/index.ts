/**
 * Posting primitives — shared between apps that write to Opera.
 *
 * Port from Python's `sql_rag/opera_sql_import.py` posting helpers
 * (id allocation, VAT tracking, anoml/snoml/pnoml writers).
 *
 * Initial release is empty; populated as the gocardless and
 * bank-reconcile rewrites progress (those apps post; balance-check
 * is read-only and doesn't need any of this).
 */

export {};
