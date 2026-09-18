import { z } from 'zod';

/**
 * A prompt is a PLAYBOOK, not a template: it tells the client LLM what to
 * ask the person, which tool to call in which order, and the rules it must
 * not break (never confirm a write the person has not seen; a price is a
 * decimal string; a current month is partial). Framework-free like the
 * tools — main/mcp registers these with the SDK.
 */
export interface PromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Prompt arguments are strings by protocol; shape them with descriptions. */
  readonly argsSchema: Record<string, z.ZodType<string | undefined>>;
  build(args: Record<string, string | undefined>): string;
}
