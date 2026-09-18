import { ApiError } from './api-error.js';

/**
 * 403: the session is valid and the caller is not allowed. Distinct from
 * UnauthorizedError on purpose — "log in" and "you are logged in and this
 * door is not yours" are different instructions.
 */
export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden') {
    super('ForbiddenError', message);
  }
}
