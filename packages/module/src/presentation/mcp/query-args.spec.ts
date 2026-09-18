import { toQuery } from './query-args.js';

describe('MCP arguments → query strings', () => {
  it('MUST stringify numbers and booleans (a query param is always text)', () => {
    expect(toQuery({ page: 2, page_size: 50, quarantined: true })).toEqual({
      page: '2',
      page_size: '50',
      quarantined: 'true',
    });
  });

  it('MUST keep multi-value filters as arrays (repeated params mean OR)', () => {
    expect(toQuery({ agent: ['a', 'b'] })).toEqual({ agent: ['a', 'b'] });
  });

  it('MUST DROP absent values: a strict schema must see them as absent, not empty', () => {
    expect(toQuery({ from: undefined, to: null, search: 'x' })).toEqual({
      search: 'x',
    });
  });

  it('MUST drop an empty array rather than send a parameter with no value', () => {
    expect(toQuery({ agent: [] })).toEqual({});
  });
});
