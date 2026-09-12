import { ConfirmationFailure } from './confirmation.js';
import { ToolError, toolError } from './tool-error.js';

/**
 * The one place a token failure becomes a tool error. Each code says what
 * the caller must do, because the caller is a language model that will
 * otherwise retry the same call: a drifted field means "run the preview
 * again and show the NEW preview to the person", never "guess again".
 */
export const fromConfirmationFailure = (
  failure: ConfirmationFailure,
): ToolError => {
  switch (failure.code) {
    case 'MISSING':
      return toolError(
        'CONFIRMATION_MISSING',
        'This tool requires the confirmation_token returned by its preview.',
        'Call the matching preview_* tool first, show its result to the person, and only then confirm with the token it returned.',
      );
    case 'MALFORMED':
      return toolError(
        'CONFIRMATION_MALFORMED',
        'The confirmation_token is not a token this server issued.',
        'Do not edit or build tokens. Run the preview again and pass its confirmation_token verbatim.',
      );
    case 'EXPIRED':
      return toolError(
        'CONFIRMATION_EXPIRED',
        'The confirmation_token has expired.',
        'Tokens are valid for a few minutes on purpose. Run the preview again, show the fresh result to the person, and confirm with the new token.',
      );
    case 'MISMATCH':
      return toolError(
        'CONFIRMATION_MISMATCH',
        `The request does not match the preview this token was issued for (${failure.fields.join(', ')}).`,
        'Never change the arguments between preview and confirm — the person approved what the preview showed. Preview the NEW request and show it before confirming.',
        { fields: [...failure.fields] },
      );
  }
};
