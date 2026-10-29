import { Router } from 'express';
import {
  makeExportStatementController,
  makeGetBillingProjectionController,
  makeGetBillingSeriesController,
  makeGetBillingSummaryController,
  makeListBillsController,
} from '../../../factories/billing-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';
import { requireCapability } from '../../../factories/auth-factory.js';
import { BILLING_LEDGER } from '../../../../presentation/capabilities.js';

/** Decision 184: these routes serve the data of `BILLING_LEDGER`. */
const readsBilling = requireCapability({ capability: BILLING_LEDGER });

/**
 * Billing read layer (T7/T8/US17) — all GET: the lifecycle (close/reopen)
 * exists only as runbook jobs in v1 (decision 87), never as HTTP.
 */
export default (router: Router): void => {
  router.get('/bills', readsBilling, adaptRoute(makeListBillsController()));
  router.get(
    '/billing/summary',
    readsBilling,
    adaptRoute(makeGetBillingSummaryController()),
  );
  router.get(
    '/billing/series',
    readsBilling,
    adaptRoute(makeGetBillingSeriesController()),
  );
  router.get(
    '/billing/projection',
    readsBilling,
    adaptRoute(makeGetBillingProjectionController()),
  );
  // One statement resource; the representation is ?format=csv|html
  // (decision 98 — RESTful, no per-format routes).
  router.get(
    '/billing/statement',
    readsBilling,
    adaptRoute(makeExportStatementController()),
  );
};
