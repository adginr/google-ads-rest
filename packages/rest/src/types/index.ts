/**
 * Google Ads REST types generated from the discovery document (`pnpm codegen`).
 * Field names are camelCase, int64 values are strings, enums are string unions: exactly what goes over the wire.
 *
 *   import type { resources, services } from '@adginr/google-ads-rest';
 *   const op: services.MutateOperation = { campaignOperation: { update: { resourceName, status: 'PAUSED' }, updateMask: 'status' } };
 */
export type * as actions from './actions.gen.ts';
export type * as common from './common.gen.ts';
export type * as errors from './errors.gen.ts';
export type * as google from './google.gen.ts';
export type * as resources from './resources.gen.ts';
export type * as services from './services.gen.ts';
