/**
 * The confirmation token of a preview (decision 177). Pure: no node:crypto,
 * no Buffer — the primitives arrive through `ConfirmationCodec`, so this
 * file is unit-testable and the crypto lives at the composition root
 * (main/mcp/node-confirmation-codec.ts).
 *
 * The token IS the record of the preview: the server stores nothing, so it
 * scales horizontally and a restart never loses a pending confirmation.
 * It binds tenant + subject, so a leaked token is useless to anyone else,
 * and the content hash makes "confirm something the user never saw"
 * impossible — any drift between the previewed request and the confirmed
 * one is refused by name.
 */
export type ConfirmationAction =
  'register_price' | 'close_period' | 'reopen_period';

export type ConfirmationKind = 'price' | 'billing_period';

export interface ConfirmationPayload {
  readonly tenant: string;
  readonly subject: string;
  readonly action: ConfirmationAction;
  readonly kind: ConfirmationKind;
  /** What is being changed: a price key, or `YYYY-MM` for a period. */
  readonly id: string;
  /** Optimistic-lock stamp of the target; '' when there is nothing to be stale against. */
  readonly etag: string;
  /** sha256 of the canonical request; '' when no payload travels. */
  readonly hash: string;
  readonly expiresAtMs: number;
}

/** What the confirming tool recomputes from the request it actually received. */
export type ExpectedConfirmation = Omit<ConfirmationPayload, 'expiresAtMs'>;

export type ConfirmationField = keyof ExpectedConfirmation;

export type ConfirmationFailure =
  | { readonly code: 'MISSING' }
  | { readonly code: 'MALFORMED' }
  | { readonly code: 'EXPIRED' }
  /** `fields` names what drifted; ['signature'] when the MAC itself fails. */
  | {
      readonly code: 'MISMATCH';
      readonly fields: readonly ConfirmationField[] | ['signature'];
    };

export type ConfirmationResult =
  | { readonly ok: true; readonly payload: ConfirmationPayload }
  | { readonly ok: false; readonly failure: ConfirmationFailure };

/**
 * The primitives the token needs. `equals` MUST be constant-time; `decode`
 * answers undefined for anything it did not encode.
 */
export interface ConfirmationCodec {
  hmac(data: string): string;
  sha256(data: string): string;
  equals(a: string, b: string): boolean;
  encode(text: string): string;
  decode(encoded: string): string | undefined;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** UTF-16 code-unit order (what `<` compares) — a hash must be identical on every runtime. */
const byCodePoint = (a: string, b: string): number =>
  a === b ? 0 : a < b ? -1 : 1;

/** Sorted keys at every level, no whitespace, arrays in order — a stable input for hashing. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort(byCodePoint)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

    return `{${entries.join(',')}}`;
  }

  return value === undefined ? 'null' : JSON.stringify(value);
};

const VERSION = 'v1';
const FIELD_COUNT = 9;
const DIGITS = /^\d+$/;
const ACTIONS: readonly string[] = [
  'register_price',
  'close_period',
  'reopen_period',
] satisfies ConfirmationAction[];
const KINDS: readonly string[] = [
  'price',
  'billing_period',
] satisfies ConfirmationKind[];

export const CONFIRMATION_FIELDS = [
  'tenant',
  'subject',
  'action',
  'kind',
  'id',
  'etag',
  'hash',
] as const satisfies readonly ConfirmationField[];

/** Pipe-joined, fixed order, versioned: the exact string the MAC covers. */
export const payloadString = (payload: ConfirmationPayload): string =>
  [
    VERSION,
    payload.tenant,
    payload.subject,
    payload.action,
    payload.kind,
    payload.id,
    payload.etag,
    payload.hash,
    String(payload.expiresAtMs),
  ].join('|');

export const mintConfirmation = (
  payload: ConfirmationPayload,
  codec: ConfirmationCodec,
): string => {
  const data = payloadString(payload);

  return `${codec.encode(data)}.${codec.hmac(data)}`;
};

const isAction = (value: string): value is ConfirmationAction =>
  ACTIONS.includes(value);
const isKind = (value: string): value is ConfirmationKind =>
  KINDS.includes(value);

const payloadOf = (data: string): ConfirmationPayload | undefined => {
  const parts = data.split('|');
  const at = (index: number): string => parts[index] ?? '';
  const action = at(3);
  const kind = at(4);

  if (
    parts.length !== FIELD_COUNT ||
    at(0) !== VERSION ||
    !isAction(action) ||
    !isKind(kind) ||
    !DIGITS.test(at(8))
  ) {
    return undefined;
  }

  return {
    tenant: at(1),
    subject: at(2),
    action,
    kind,
    id: at(5),
    etag: at(6),
    hash: at(7),
    expiresAtMs: Number(at(8)),
  };
};

/**
 * Phase one, no expectation needed: MISSING, MALFORMED, or a MAC that does
 * not cover the payload (a forged token says nothing about fields). The
 * payload comes back so a caller can see what the preview was bound to
 * before it re-reads the target (that is how a period compares its etag
 * AFTER a fresh read, never against a value the token could dictate).
 */
export const decodeConfirmation = (
  token: string | undefined,
  codec: ConfirmationCodec,
): ConfirmationResult => {
  if (token === undefined || token === '') {
    return { ok: false, failure: { code: 'MISSING' } };
  }

  const [encoded, mac, ...rest] = token.split('.');

  if (encoded === undefined || mac === undefined || rest.length > 0) {
    return { ok: false, failure: { code: 'MALFORMED' } };
  }

  const data = codec.decode(encoded);
  const payload = data === undefined ? undefined : payloadOf(data);

  if (data === undefined || payload === undefined) {
    return { ok: false, failure: { code: 'MALFORMED' } };
  }

  if (!codec.equals(codec.hmac(data), mac)) {
    return { ok: false, failure: { code: 'MISMATCH', fields: ['signature'] } };
  }

  return { ok: true, payload };
};

/** Phase two: the fields the confirming tool recomputed, then the window. */
export const matchConfirmation = (
  payload: ConfirmationPayload,
  expected: ExpectedConfirmation,
  nowMs: number,
  fields: readonly ConfirmationField[] = CONFIRMATION_FIELDS,
): ConfirmationResult => {
  const drifted = fields.filter((field) => payload[field] !== expected[field]);

  if (drifted.length > 0) {
    return { ok: false, failure: { code: 'MISMATCH', fields: drifted } };
  }

  if (nowMs >= payload.expiresAtMs) {
    return { ok: false, failure: { code: 'EXPIRED' } };
  }

  return { ok: true, payload };
};

/** Signature → fields → window: what a confirming tool runs BEFORE any store call. */
export const verifyConfirmation = (
  token: string | undefined,
  expected: ExpectedConfirmation,
  nowMs: number,
  codec: ConfirmationCodec,
  fields: readonly ConfirmationField[] = CONFIRMATION_FIELDS,
): ConfirmationResult => {
  const decoded = decodeConfirmation(token, codec);

  return decoded.ok
    ? matchConfirmation(decoded.payload, expected, nowMs, fields)
    : decoded;
};
