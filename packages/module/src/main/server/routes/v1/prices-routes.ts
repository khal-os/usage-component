import { Router } from 'express';
import {
  makeListPriceVersionsController,
  makeRegisterPriceVersionController,
} from '../../../factories/price-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';
import { requireCapability } from '../../../factories/auth-factory.js';
import { BILLING_LEDGER } from '../../../../presentation/capabilities.js';

/** Decision 184: these routes serve the data of `BILLING_LEDGER`. */
const readsBilling = requireCapability({ capability: BILLING_LEDGER });
/** Registering a price is the Khal team's: the billing data AND the master role. */
const registersPrice = requireCapability({
  capability: BILLING_LEDGER,
  masterOnly: true,
});

export default (router: Router): void => {
  // US4 / audit D-3: the price table is READABLE — registering is not the
  // only door, and the pending_price diagnostic needs to SEE the rows.
  router.get(
    '/prices',
    readsBilling,
    adaptRoute(makeListPriceVersionsController()),
  );
  router.post(
    '/prices',
    registersPrice,
    adaptRoute(makeRegisterPriceVersionController()),
  );
};
