import { z } from 'zod';
import { PromptDefinition } from './prompt-definition.js';

const monthArgs = {
  year: z.string().describe('Calendar year, e.g. 2026.'),
  month: z.string().describe('Calendar month, 1-12.'),
};

const RULES = [
  'Every value you report is in R$. There is no other currency in this archive.',
  'A cost is stamped when the execution is ingested and never changes afterwards. A later price change only affects executions ingested after it.',
  'An execution with no applicable price is pending_price: its cost is OPEN, not zero. Never present it as R$ 0.00 and never add it into a total.',
  'A closed month is final and comes from its frozen snapshot. The current month is always partial — say so every time you show it.',
].join('\n- ');

const WRITE_RULES = [
  'Writes are two steps: call the preview tool, show the person its result in full, and call the confirming tool only after they explicitly approve.',
  'Pass the confirmation_token exactly as the preview returned it, and never change the other arguments between the two calls — the person approved what the preview showed.',
  'If a token is refused as expired or mismatched, preview again and show the NEW preview before confirming.',
].join('\n- ');

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'explain-bill',
    title: 'Explain a month bill',
    description:
      'Walk a manager through one month: the total, who spent it, and the line-by-line account behind it.',
    argsSchema: monthArgs,
    build: (args) =>
      [
        `Explain the bill for ${args['year'] ?? '<year>'}-${args['month'] ?? '<month>'} to a manager who has not seen this data before.`,
        '',
        'Do this:',
        '1. Call get_billing_summary for the month. Lead with the total and whether the month is closed (final) or in progress (partial).',
        '2. Show the cost per agent as a short table, with the percentage of the total.',
        '3. Pick the biggest line of the drill-down and show the account behind it: tokens x price per million = cost, naming the price version date.',
        '4. Report the model mix and the cache savings in one sentence each.',
        '5. Compare with the previous month and say plainly whether it went up or down, and by how much.',
        '6. If the month reports executions waiting for a price, say how many and which models are missing a price, and that their cost is not in the total.',
        '7. If the month was reopened, mention the audited reason.',
        '',
        'Rules you must follow:',
        `- ${RULES}`,
      ].join('\n'),
  },
  {
    name: 'find-cost-driver',
    title: 'Find what is driving the cost',
    description:
      'Go from the month total down to the conversations and executions responsible for it.',
    argsSchema: monthArgs,
    build: (args) =>
      [
        `Find what is driving the cost of ${args['year'] ?? '<year>'}-${args['month'] ?? '<month>'}.`,
        '',
        'Do this:',
        '1. get_billing_summary for the month: note the agents and models with the largest share.',
        '2. get_billing_series with granularity day to see whether the spend is steady or spiked, and name the days that stand out.',
        '3. For the leading agent, list_sessions filtered by that agent over the month, ordered by what the API returns, and report the most expensive conversations.',
        '4. get_session on the top conversation and summarise what happened in it: how many executions, whether any failed, where the tokens went.',
        '5. If a single execution dominates, get_trace on it and show the cost account line by line.',
        '6. End with one paragraph: what is driving the cost, and what someone could change.',
        '',
        'Rules you must follow:',
        `- ${RULES}`,
      ].join('\n'),
  },
  {
    name: 'register-price',
    title: 'Register a contracted price',
    description:
      'Register a new price version safely: check what exists, preview, confirm with the person.',
    argsSchema: {
      model: z
        .string()
        .optional()
        .describe('Model the price is for, if the person already said it.'),
    },
    build: (args) =>
      [
        args['model']
          ? `Register a contracted price for the model ${args['model']}.`
          : 'Register a contracted price in the price table.',
        '',
        'Ask the person for anything you do not have yet: the model, the token type (input, output, cache_read or cache_write), the price in R$ per MILLION tokens, and the date the price starts to apply.',
        '',
        'Do this:',
        '1. Call list_prices for that model first and show what already exists. Versions are immutable — a change is a NEW version with a later date.',
        '2. Call preview_register_price. Show the person the canonical model key it will be stored under, the existing versions and every warning it returns.',
        '3. Ask for explicit approval, then call register_price with the token from the preview.',
        '4. Report the re-stamp result: how many executions that were waiting for a price got priced, and how many are still pending.',
        '',
        'Rules you must follow:',
        `- The price is a decimal STRING in R$ per million tokens, for example "2.75". Never a number, never zero: a zero would stamp executions at R$ 0.00 forever.`,
        '- The date decides WHICH executions get this price: an execution is priced with the version in force on the execution date.',
        `- ${WRITE_RULES}`,
        `- ${RULES}`,
      ].join('\n'),
  },
  {
    name: 'close-month',
    title: 'Close a month',
    description:
      'Take a month from open to closed: check the blockers, preview, confirm, report the frozen total.',
    argsSchema: monthArgs,
    build: (args) =>
      [
        `Close the billing month ${args['year'] ?? '<year>'}-${args['month'] ?? '<month>'}.`,
        '',
        'Do this:',
        '1. Call list_bills and show the month with its current status and total.',
        '2. Call preview_close_billing_period. If it reports blockers, explain each one in plain words and stop — do not try to close.',
        '3. If executions are waiting for a price, offer to register the missing prices first (the register-price playbook), then preview again.',
        '4. With no blockers, show the person what closing means: the statement is frozen and becomes the bill, and undoing it needs an audited reopen.',
        '5. After explicit approval, call close_billing_period with the token from the preview and report the final total, the snapshot version and any executions that arrived late.',
        '',
        'Rules you must follow:',
        '- Only a month that has fully ended can close, and months close oldest first.',
        '- Reopening a closed month is the exception, needs a written reason, and is audited. Never reopen without being asked to.',
        `- ${WRITE_RULES}`,
        `- ${RULES}`,
      ].join('\n'),
  },
];
