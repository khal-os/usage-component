/**
 * MCP arguments arrive as JSON with real types (a page is the number 2);
 * the controllers are the HTTP door's controllers and read query strings
 * (`'2'`). This is the ONE translation between the two — every read tool
 * goes through it, so no tool grows its own parsing, and the controller
 * stays the single validator (a bad value still answers the HTTP 400 that
 * `fromHttpResponse` turns into INVALID_INPUT).
 *
 * `undefined` keys are dropped: an absent optional filter must look absent
 * to a strict schema, not present-and-empty.
 */
export const toQuery = (
  args: Record<string, unknown>,
): Record<string, string | string[]> => {
  const query: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      const entries = value.map((item) => String(item));
      if (entries.length > 0) query[key] = entries;
      continue;
    }

    query[key] = String(value);
  }

  return query;
};
