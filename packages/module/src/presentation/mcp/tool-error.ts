import { HttpResponse } from '../interfaces/index.js';

/**
 * What a tool failure looks like on the wire (T12): a tool RESULT with
 * `isError`, carrying a JSON body — never a thrown exception and never a
 * JSON-RPC error. A client LLM has to be able to read the failure and fix
 * the call, so every code ships with a `hint` that says what to do next.
 */
export type ToolErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'BLOCKED'
  | 'STALE_PERIOD'
  | 'CONFIRMATION_MISSING'
  | 'CONFIRMATION_MALFORMED'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_MISMATCH'
  | 'INTERNAL';

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly hint: string;
  /** Extra machine-readable context (e.g. the blockers of a close, the drifted fields). */
  readonly details?: Record<string, unknown>;
}

export const toolError = (
  code: ToolErrorCode,
  message: string,
  hint: string,
  details?: Record<string, unknown>,
): ToolError => ({ code, message, hint, ...(details && { details }) });

/** The API's error wire shape is `{ name, msg }` (presentation/errors/api-error.ts). */
const messageOf = (body: unknown, fallback: string): string => {
  if (typeof body === 'object' && body !== null && 'msg' in body) {
    const { msg } = body as { msg?: unknown };
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
};

const HINTS: Record<number, { code: ToolErrorCode; hint: string }> = {
  400: {
    code: 'INVALID_INPUT',
    hint: 'The message names the offending field. Read the tool input schema again — unknown fields are refused on purpose, they are never ignored.',
  },
  404: {
    code: 'NOT_FOUND',
    hint: 'The id does not exist in this archive. Find it first with the matching list tool.',
  },
  409: {
    code: 'CONFLICT',
    hint: 'The resource already exists and is immutable. Register a new version instead of rewriting this one.',
  },
  413: {
    code: 'INVALID_INPUT',
    hint: 'The request body is too large.',
  },
  415: {
    code: 'INVALID_INPUT',
    hint: 'The request body must be JSON.',
  },
};

/**
 * The HTTP door and the MCP door answer the same failures — this is the ONE
 * translation (a second mapping table would be the repo's own named
 * root-cause pattern: one rule, two spellings). 5xx never travels: the
 * caller gets "internal error" and the detail stays in the server log.
 */
export const fromHttpResponse = (response: HttpResponse): ToolError => {
  const mapped = HINTS[response.statusCode];

  if (!mapped) {
    return toolError(
      'INTERNAL',
      'The component failed to answer this call.',
      'Retry once; if it keeps failing, the operator has to look at the module logs.',
    );
  }

  return toolError(
    mapped.code,
    messageOf(
      response.body,
      `Request refused with status ${String(response.statusCode)}.`,
    ),
    mapped.hint,
  );
};
