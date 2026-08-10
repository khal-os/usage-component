/**
 * Display formatting for client-facing view models (pt-BR). The API owns
 * EVERY derived/formatted value the UI shows — the front-end only binds
 * fields to the DOM (decision 51). Datetimes are rendered in the CLIENT's
 * timezone (decision 130: display zone ≡ billing zone, from the one
 * required CLIENT_TIMEZONE knob — read per instant via the client clock,
 * so DST zones stay correct; single-tenant deployment, invariant 5).
 */

import { clientUtcOffsetMs } from '../clock/client-clock.js';

const MONTHS_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 21038 -> "21.038" (pt-BR thousands grouping). */
export const formatIntDisplay = (value: number): string => {
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.trunc(Math.abs(value)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `${sign}${grouped}`;
};

/** Decimal string "1234.56" -> "R$ 1.234,56"; "0.00096525" -> "R$ 0,00096525". */
export const formatBrlDisplay = (decimalString: string): string => {
  const [integerPart = '0', fractionPart] = decimalString.split('.');
  const grouped = formatIntDisplay(Number(integerPart));

  return fractionPart !== undefined
    ? `R$ ${grouped},${fractionPart}`
    : `R$ ${grouped}`;
};

/** 731 -> "731 ms"; 1200 -> "1,2 s"; 19800 -> "19,8 s"; 60000 -> "60 s". */
export const formatDurationDisplay = (rawDurationMs: number): string => {
  // Legacy documents ingested before the write-boundary clamp may carry
  // clock-skewed negative durations — never show a negative time.
  const durationMs = Math.max(rawDurationMs, 0);

  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const tenths = Math.round(durationMs / 100);
  const seconds = Math.trunc(tenths / 10);
  const fraction = tenths % 10;

  return fraction === 0 ? `${seconds} s` : `${seconds},${fraction} s`;
};

/** "20/07/2026, 14:51:22" in the client timezone (decision 130). */
export const formatDateTimeDisplay = (date: Date): string => {
  const local = new Date(date.getTime() + clientUtcOffsetMs(date));

  return (
    `${pad2(local.getUTCDate())}/${pad2(local.getUTCMonth() + 1)}/` +
    `${local.getUTCFullYear()}, ${pad2(local.getUTCHours())}:` +
    `${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`
  );
};

/**
 * "01/07/2026" — calendar date in UTC. For PRICE effective dates only,
 * which remain UTC calendar dates (QA19 resolved, decision 138: price
 * effectiveness is an instant comparison, deliberately untouched by
 * decision 130). Day bucketing of traces uses formatClientDateDisplay
 * below.
 */
export const formatUtcDateDisplay = (date: Date): string =>
  `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;

/** "01/07/2026" — calendar date in the CLIENT zone (decision 130). */
export const formatClientDateDisplay = (date: Date): string => {
  const local = new Date(date.getTime() + clientUtcOffsetMs(date));

  return formatUtcDateDisplay(local);
};

/** Relative age at request time: "agora", "há 35 min", "há 2 h", "há 3 d". */
export const formatAgeDisplay = (date: Date, now: Date): string => {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);

  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `há ${hours} h`;

  return `há ${Math.floor(hours / 24)} d`;
};

/** (2026, 7) -> "julho de 2026". */
export const formatMonthLabel = (year: number, month: number): string =>
  `${MONTHS_PT[month - 1]} de ${year}`;

/** Serialize an unknown payload for display: strings as-is, else pretty JSON. */
export const contentToText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;

  return JSON.stringify(value, null, 2);
};
