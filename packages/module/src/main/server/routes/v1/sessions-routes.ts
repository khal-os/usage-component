import { Router } from 'express';
import {
  makeGetSessionDetailController,
  makeListSessionFilterOptionsController,
  makeListSessionsController,
} from '../../../factories/sessions-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';
import { requireCapability } from '../../../factories/auth-factory.js';
import { TRACING_SESSIONS } from '../../../../presentation/capabilities.js';

/** Decision 184: these routes serve the data of `TRACING_SESSIONS`. */
const readsTracing = requireCapability({ capability: TRACING_SESSIONS });

export default (router: Router): void => {
  router.get(
    '/sessions',
    readsTracing,
    adaptRoute(makeListSessionsController()),
  );
  // Before /sessions/:id — otherwise "filters" is captured as an id.
  router.get(
    '/sessions/filters',
    readsTracing,
    adaptRoute(makeListSessionFilterOptionsController()),
  );
  router.get(
    '/sessions/:id',
    readsTracing,
    adaptRoute(makeGetSessionDetailController()),
  );
};
