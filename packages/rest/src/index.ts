export { GOOGLE_ADS_API_VERSION } from './api-version.ts';
export {
	GoogleAdsClient,
	type GoogleAdsConfig,
	type GoogleAdsRow,
	MAX_CLICK_CONVERSIONS_PER_REQUEST,
	type MutateOptions,
	type UploadClickConversionsOptions,
	type UploadClickConversionsResult
} from './client.ts';
export { GoogleAdsError, type GoogleAdsErrorEntry } from './errors.ts';
export { GAQL_RESOURCES, type GaqlResource } from './gaql-resources.gen.ts';
export * from './gaql.ts';
export * from './mutate-plan.ts';
export * from './operations.ts';
export * from './resource-names.ts';
export type * from './types/index.ts';
