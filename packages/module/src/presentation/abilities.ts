/**
 * What a company may choose, person by person, in this module (decision 185).
 * The ids its module manifest declares in `abilities`, in the format apps use
 * (khal-platform ADR-152 and ADR-164): the local ids, `area.action`. A grant
 * stores them, so an id is never renamed; the labels may change at any time.
 */
export const TRACING_READ = 'tracing.read';
export const BILLING_READ = 'billing.read';
export const BILLING_EXPORT = 'billing.export';

export type Ability =
  typeof TRACING_READ | typeof BILLING_READ | typeof BILLING_EXPORT;

/** The manifest's `abilities` section, as the Module Catalog takes it. */
export const MANIFEST_ABILITIES = {
  areas: [
    { id: 'tracing', label: { 'pt-BR': 'Traces', 'en-US': 'Traces' } },
    { id: 'billing', label: { 'pt-BR': 'Faturamento', 'en-US': 'Billing' } },
  ],
  items: [
    {
      id: TRACING_READ,
      label: {
        'pt-BR': 'Ver traces e sessões',
        'en-US': 'See traces and sessions',
      },
    },
    {
      id: BILLING_READ,
      label: { 'pt-BR': 'Ver faturamento', 'en-US': 'See billing' },
    },
    {
      id: BILLING_EXPORT,
      label: { 'pt-BR': 'Exportar extrato', 'en-US': 'Export the statement' },
    },
  ],
} as const;
