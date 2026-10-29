/**
 * The capabilities this component offers (decision 184) — the ids its
 * module manifest declares in `capabilities[].capability`
 * (scripts/register-module.sh) and the ones an app's manifest names in
 * `uses`. Each API route and each MCP tool belongs to the data of one of
 * them, and khal-auth gives a person exactly the ones the apps they received
 * use (khal-platform ADR-163).
 */
export const BILLING_LEDGER = 'billing.ledger';
export const TRACING_SESSIONS = 'tracing.sessions';

export type Capability = typeof BILLING_LEDGER | typeof TRACING_SESSIONS;
