/**
 * The `VisitsApi` port, each method on the backend that serves it today.
 *
 * The visit and its payments are V1 (`./v1/visits-adapter.ts`); product lines
 * are the V2 appointment save (`./v2/visit-products-adapter.ts`). No route of
 * either version serves the whole Visit resource, so the port is put together
 * here per method. A V3 adapter implements the whole port and takes this
 * one's place.
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import { VisitsV1Adapter } from './v1/visits-adapter.js';
import { VisitProductsV2Adapter } from './v2/visit-products-adapter.js';
import type {
  VisitPaymentsApi,
  VisitProductLinesApi,
  VisitsApi,
} from './visits-api.js';

export class VisitsAdapter implements VisitsApi {
  constructor(
    private readonly payments: VisitPaymentsApi,
    private readonly productLines: VisitProductLinesApi
  ) {}

  static forClient(client: AltegioClient): VisitsAdapter {
    return new VisitsAdapter(
      VisitsV1Adapter.forClient(client),
      VisitProductsV2Adapter.forClient(client)
    );
  }

  getVisit: VisitsApi['getVisit'] = (...args) =>
    this.payments.getVisit(...args);
  addPayment: VisitsApi['addPayment'] = (...args) =>
    this.payments.addPayment(...args);
  cancelPayment: VisitsApi['cancelPayment'] = (...args) =>
    this.payments.cancelPayment(...args);

  getAppointmentSale: VisitsApi['getAppointmentSale'] = (...args) =>
    this.productLines.getAppointmentSale(...args);
  getProductForSale: VisitsApi['getProductForSale'] = (...args) =>
    this.productLines.getProductForSale(...args);
  addProductLine: VisitsApi['addProductLine'] = (...args) =>
    this.productLines.addProductLine(...args);
  reduceProductLine: VisitsApi['reduceProductLine'] = (...args) =>
    this.productLines.reduceProductLine(...args);
}
