import { Controller } from '../interfaces/index.js';
import { ResourceDefinition } from './resource-definition.js';

export interface ResourceDependencies {
  /** The generated OpenAPI document of this deployment, as JSON text. */
  readonly openApiJson: () => string;
  readonly listBills: Controller;
  readonly listPrices: Controller;
}

const jsonOf = async (controller: Controller): Promise<string> => {
  const response = await controller.handle({ query: {} });

  return JSON.stringify(response.body, null, 2);
};

export const resources = (deps: ResourceDependencies): ResourceDefinition[] => [
  {
    uri: 'usage://openapi.json',
    name: 'openapi',
    title: 'HTTP contract of this component',
    description:
      'The OpenAPI document of the read API these tools mirror. Read it when you need the exact meaning of a field, a filter or a status.',
    mimeType: 'application/json',
    read: async () => deps.openApiJson(),
  },
  {
    uri: 'usage://bills',
    name: 'bills',
    title: 'Months and their status',
    description:
      'Every calendar month present in the archive with its lifecycle status and total — the same body list_bills returns.',
    mimeType: 'application/json',
    read: async () => jsonOf(deps.listBills),
  },
  {
    uri: 'usage://prices',
    name: 'prices',
    title: 'Contracted price table',
    description:
      'Every price version in force, in R$ per million tokens — the same body list_prices returns without filters.',
    mimeType: 'application/json',
    read: async () => jsonOf(deps.listPrices),
  },
];
