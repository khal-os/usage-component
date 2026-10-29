import { Router } from 'express';
import {
  makeGetTraceDetailController,
  makeListTraceFilterOptionsController,
  makeListTracesController,
} from '../../../factories/traces-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';
import { requireCapability } from '../../../factories/auth-factory.js';
import { TRACING_SESSIONS } from '../../../../presentation/capabilities.js';

/** Decision 184: these routes serve the data of `TRACING_SESSIONS`. */
const readsTracing = requireCapability({ capability: TRACING_SESSIONS });

export default (router: Router): void => {
  router.get('/traces', readsTracing, adaptRoute(makeListTracesController()));
  // Before /traces/:id — Express matches in order; :id would swallow it.
  router.get(
    '/traces/filters',
    readsTracing,
    adaptRoute(makeListTraceFilterOptionsController()),
  );
  router.get(
    '/traces/:id',
    readsTracing,
    adaptRoute(makeGetTraceDetailController()),
  );
};
