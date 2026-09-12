import { fromHttpResponse } from './tool-error.js';

describe('MCP tool errors (the one HTTP → tool translation)', () => {
  it('MUST map a 400 to INVALID_INPUT keeping the message that names the field', () => {
    const error = fromHttpResponse({
      statusCode: 400,
      body: { name: 'InvalidParamError', msg: 'Invalid parameter: month' },
    });

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('Invalid parameter: month');
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('MUST map 404 to NOT_FOUND and 409 to CONFLICT', () => {
    expect(
      fromHttpResponse({
        statusCode: 404,
        body: { name: 'NotFoundError', msg: 'Not found: trace x' },
      }).code,
    ).toBe('NOT_FOUND');
    expect(
      fromHttpResponse({
        statusCode: 409,
        body: { name: 'ConflictError', msg: 'already exists' },
      }).code,
    ).toBe('CONFLICT');
  });

  it('MUST NOT leak a server failure: 500 becomes an opaque INTERNAL', () => {
    const error = fromHttpResponse({
      statusCode: 500,
      body: {
        name: 'ServerError',
        msg: 'connection to db-7 refused at 10.0.0.4',
      },
    });

    expect(error.code).toBe('INTERNAL');
    expect(error.message).not.toContain('10.0.0.4');
  });

  it('MUST survive a body that is not the {name,msg} shape', () => {
    const error = fromHttpResponse({ statusCode: 400, body: 'plain text' });

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('400');
  });
});
