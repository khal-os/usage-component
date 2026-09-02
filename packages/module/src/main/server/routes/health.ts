import { Application, Request, Response } from 'express';

/**
 * decision 172: GET /health is OPEN — the platform convention every
 * register follows (khal-platform's http-kit `healthRoute`), and the path
 * the module manifests declare in `connection.health`. Its consumers have
 * no token: orchestrator probes and the Catalog Console's health chip
 * (which probes from the browser, so the response must carry the CORS
 * echo — see the registration site in middlewares-setup for why position
 * is the contract).
 *
 * It proves the PROCESS answers and nothing more — no Mongo touch, so a
 * database outage never reads as a dead pod (same rationale as the
 * docs-as-healthcheck of decision 103, which stays in place for the
 * chart's probes until PENDENTE-1's flip). `no-store` because a cached
 * "ok" would defeat the probe.
 */
export const registerHealthRoute = (app: Application): void => {
  app.get('/health', (_req: Request, res: Response) => {
    res.set('cache-control', 'no-store');
    res.status(200).json({ status: 'ok', component: 'usage-module' });
  });
};
