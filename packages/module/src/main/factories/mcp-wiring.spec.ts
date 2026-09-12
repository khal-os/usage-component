import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The MCP composition, pinned where it matters (the factory reads config at
 * import time and builds Mongo-backed controllers, so this is a SOURCE-level
 * pin like the scheduler's — same technique, same reason).
 *
 * What must never drift:
 *  - the endpoint is opt-in (no canonical url ⇒ no runtime, no route);
 *  - the MCP door goes up BEFORE the /api/v1 session gate and AFTER cors;
 *  - the lifecycle tools are composed with trigger 'mcp' AND the caller as
 *    actor — an audit trail that says who closed a month is only worth what
 *    this pin enforces;
 *  - the tools reach storage only through the same factories the HTTP routes
 *    use (never a repository directly).
 */
describe('MCP wiring (decisions 175/176/179)', () => {
  const source = (relativePath: string): string =>
    readFileSync(join(process.cwd(), 'src', relativePath), 'utf-8');

  const factory = source('main/factories/mcp-factory.ts');

  it('MUST return no runtime when MCP_CANONICAL_URL is unset (opt-in)', () => {
    expect(factory).toContain('const canonicalUrl = config.mcpCanonicalUrl;');
    expect(factory).toMatch(/if \(!canonicalUrl\) \{[\s\S]*return undefined;/);
  });

  it('MUST fail closed when the endpoint is configured but its contract is not', () => {
    expect(factory).toMatch(
      /if \(!authUrl \|\| !tenant \|\| !audience \|\| !confirmationKey\) \{[\s\S]*return undefined;/,
    );
  });

  it("MUST compose the lifecycle with trigger 'mcp' and the caller as actor", () => {
    expect(factory).toContain("makeCloseBillingPeriodUseCase('mcp', actor)");
    expect(factory).toContain("makeReopenBillingPeriodUseCase('mcp', actor)");
  });

  it('MUST reach storage only through the route factories (never a repository)', () => {
    expect(factory).not.toMatch(
      new RegExp(String.raw`new MongoDb|from\s+'mongodb'`),
    );
    for (const maker of [
      'makeListTracesController()',
      'makeListSessionsController()',
      'makeListBillsController()',
      'makeGetBillingSummaryController()',
      'makeListPriceVersionsController()',
      'makeRegisterPriceVersionController()',
    ]) {
      expect(factory).toContain(maker);
    }
  });

  it('MUST mount the endpoint after CORS and BEFORE the session gate (position is the contract)', () => {
    const setup = source('main/server/helpers/middlewares-setup.ts');
    const cors = setup.indexOf('app.use(corsMiddleware)');
    const mcp = setup.indexOf('registerMcpRoutes(app, mcp)');
    const gate = setup.indexOf('app.use(makeAuthMiddleware())');

    expect(cors).toBeGreaterThan(-1);
    expect(mcp).toBeGreaterThan(cors);
    expect(gate).toBeGreaterThan(mcp);
  });

  it('MUST build the confirmation codec from the configured key only', () => {
    expect(factory).toContain('makeNodeConfirmationCodec(confirmationKey)');
    expect(factory).not.toMatch(/makeNodeConfirmationKey\(['"]/);
  });
});
