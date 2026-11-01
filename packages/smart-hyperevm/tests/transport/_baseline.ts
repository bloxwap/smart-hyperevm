/**
 * The router features that default on, turned off. Tests that exercise one mechanism (routing, failover, the
 * breaker, one feature) spread this first, so their own options still win and the other features stay out of the way.
 */
export const BASELINE = { race: false, pinLatest: false, cache: false } as const;
