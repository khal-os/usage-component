import { z } from 'zod';
import { ToolError } from './tool-error.js';

/**
 * A tool descriptor, free of any MCP framework type: the protocol border
 * lives in main/mcp (like express lives in main/adapters), so this layer
 * can be unit-tested by calling `run` directly — no server, no transport.
 */
export interface ToolDocument {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface ToolSuccess {
  /** The tool's structured result — validated against `outputSchema` by the SDK. */
  readonly structured: Record<string, unknown>;
  /** Optional one-line summary for clients that only render text. */
  readonly text?: string;
  /** A document the caller should keep verbatim (statement exports). */
  readonly document?: ToolDocument;
}

export type ToolOutcome =
  | { readonly ok: true; readonly value: ToolSuccess }
  | { readonly ok: false; readonly error: ToolError };

export const toolOk = (
  structured: Record<string, unknown>,
  extra: { text?: string; document?: ToolDocument } = {},
): ToolOutcome => ({
  ok: true,
  value: {
    structured,
    ...(extra.text !== undefined && { text: extra.text }),
    ...(extra.document !== undefined && { document: extra.document }),
  },
});

export const toolFailed = (error: ToolError): ToolOutcome => ({
  ok: false,
  error,
});

/** Who is calling: the verified session behind this request (never a machine). */
export interface ToolCaller {
  /** `sub` of the session token — the actor recorded on audited writes. */
  readonly subject: string;
  /** `tenant` claim, already checked against KHAL_TENANT by the gate. */
  readonly tenant: string;
}

/**
 * MCP tool annotations (the three hints the protocol defines). A read tool
 * is `readOnly` + `idempotent`; a confirming write is neither; `destructive`
 * is reserved for what a human would call destructive (reopening a closed
 * month rewrites the bill's history).
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly idempotentHint: boolean;
  readonly destructiveHint: boolean;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
};

/** A preview writes nothing, but repeating it mints a new token — not idempotent. */
export const PREVIEW: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: false,
  destructiveHint: false,
};

export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
};

export const DESTRUCTIVE_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
};

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Raw zod shape — the SDK turns it into the tool's JSON Schema. */
  readonly inputSchema: z.ZodRawShape;
  /** The response contract: the SAME strict view schema the HTTP route publishes. */
  readonly outputSchema: z.ZodType;
  readonly annotations: ToolAnnotations;
  run(args: Record<string, unknown>, caller: ToolCaller): Promise<ToolOutcome>;
}
