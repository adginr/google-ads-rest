/**
 * Google Ads REST client: OAuth refresh-token auth, GAQL search, atomic mutate and a few non-GAQL services.
 * The only file that talks HTTP to Google.
 *
 * No developer token: Google sunset them on 2026-09-09; the API access level now comes from the Google
 * Cloud project that owns the OAuth client.
 * https://developers.google.com/google-ads/api/docs/api-policy/developer-token
 *
 * REST reference: https://developers.google.com/google-ads/api/rest/overview
 */
import { GOOGLE_ADS_API_VERSION } from './api-version.ts';
import { GoogleAdsError } from './errors.ts';
import type { resources, services } from './types/index.ts';

const API_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdsConfig {
	/** OAuth client ID ("Desktop app" client works for local use). */
	clientId?: string;
	clientSecret?: string;
	/** Refresh token with the `https://www.googleapis.com/auth/adwords` scope. */
	refreshToken?: string;
	/** Manager (MCC) account used to reach client accounts. Digits; dashes are stripped. */
	loginCustomerId?: string;
	/** Custom fetch, e.g. for tests or a proxy. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
}

/** One GAQL result row: nested objects keyed by resource (`campaign`, `metrics`, ...), camelCase fields. */
export type GoogleAdsRow = services.GoogleAdsRow;

export interface MutateOptions {
	/** Validate the request without executing it. Nothing is created; results carry no resource names. */
	validateOnly?: boolean;
}

export class GoogleAdsClient {
	#accessToken?: { value: string; expiresAt: number };
	readonly #config: GoogleAdsConfig;
	readonly #fetch: typeof fetch;

	constructor(config: GoogleAdsConfig) {
		this.#config = {
			...config,
			loginCustomerId: config.loginCustomerId?.replaceAll('-', '') || undefined
		};
		this.#fetch = config.fetch ?? globalThis.fetch;
	}

	/** Builds a client from `GOOGLE_ADS_*` environment variables. */
	static fromEnv(env: Record<string, string | undefined> = process.env): GoogleAdsClient {
		return new GoogleAdsClient({
			clientId: env.GOOGLE_ADS_CLIENT_ID,
			clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
			refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
			loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
		});
	}

	/** `customers/1234567890` resource names the OAuth user can access directly. */
	async listAccessibleCustomers(): Promise<string[]> {
		const body = await this.#request<services.ListAccessibleCustomersResponse>(
			'GET',
			'/customers:listAccessibleCustomers'
		);
		return body.resourceNames ?? [];
	}

	/**
	 * Runs a GAQL query, following pagination until `maxRows` rows are collected.
	 * Note REST returns int64 fields as strings and omits fields with default values (0, false, '').
	 */
	async search(
		customerId: string,
		query: string,
		{ maxRows = 10_000 } = {}
	): Promise<GoogleAdsRow[]> {
		const rows: GoogleAdsRow[] = [];
		let pageToken: string | undefined;
		do {
			const body = await this.#request<services.SearchGoogleAdsResponse>(
				'POST',
				`/customers/${customerId}/googleAds:search`,
				{ query, pageToken } satisfies services.SearchGoogleAdsRequest
			);
			rows.push(...(body.results ?? []));
			pageToken = body.nextPageToken;
		} while (pageToken && rows.length < maxRows);
		return rows.slice(0, maxRows);
	}

	/**
	 * Atomic mutate across resource types (GoogleAdsService.Mutate): all operations succeed or none do.
	 * Throws if Google returns fewer results than operations sent (never silently drops one).
	 */
	async mutate(
		customerId: string,
		operations: services.MutateOperation[],
		{ validateOnly = false }: MutateOptions = {}
	): Promise<services.MutateOperationResponse[]> {
		if (!operations.length) throw new GoogleAdsError('mutate needs at least one operation.');
		const body = await this.#request<services.MutateGoogleAdsResponse>(
			'POST',
			`/customers/${customerId}/googleAds:mutate`,
			{ mutateOperations: operations, validateOnly } satisfies services.MutateGoogleAdsRequest
		);
		const results = body.mutateOperationResponses ?? [];
		if (!validateOnly && results.length < operations.length) {
			throw new GoogleAdsError(
				`Mutate returned ${results.length} results for ${operations.length} operations.`
			);
		}
		return results;
	}

	/** Keyword Planner ideas (KeywordPlanIdeaService.GenerateKeywordIdeas), following pagination. */
	async generateKeywordIdeas(
		customerId: string,
		request: Omit<services.GenerateKeywordIdeasRequest, 'pageToken'>,
		{ maxResults = 1000 } = {}
	): Promise<services.GenerateKeywordIdeaResult[]> {
		const results: services.GenerateKeywordIdeaResult[] = [];
		let pageToken: string | undefined;
		do {
			const body = await this.#request<services.GenerateKeywordIdeaResponse>(
				'POST',
				`/customers/${customerId}:generateKeywordIdeas`,
				{ ...request, pageToken }
			);
			results.push(...(body.results ?? []));
			pageToken = body.nextPageToken;
		} while (pageToken && results.length < maxResults);
		return results.slice(0, maxResults);
	}

	/**
	 * Creates an empty batch job (BatchJobService) for operations too many for one atomic mutate. Add
	 * operations with `addBatchJobOperations`, then start it with `runBatchJob`. `MutatePlan` wraps the
	 * whole flow. Batch jobs are not atomic and have no dry run.
	 */
	async createBatchJob(customerId: string): Promise<string> {
		const body = await this.#request<services.MutateBatchJobResponse>(
			'POST',
			`/customers/${customerId}/batchJobs:mutate`,
			{ operation: { create: {} } } satisfies services.MutateBatchJobRequest
		);
		const resourceName = body.result?.resourceName;
		if (!resourceName) throw new GoogleAdsError('Creating a batch job returned no resource name.');
		return resourceName;
	}

	/**
	 * Appends operations to a batch job that has not run yet. Pass the previous call's
	 * `nextSequenceToken` as `sequenceToken` so Google rejects calls arriving out of order.
	 */
	async addBatchJobOperations(
		batchJob: string,
		operations: services.MutateOperation[],
		sequenceToken?: string
	): Promise<{ nextSequenceToken?: string; totalOperations: number }> {
		const body = await this.#request<services.AddBatchJobOperationsResponse>(
			'POST',
			`/${batchJob}:addOperations`,
			{
				mutateOperations: operations,
				sequenceToken
			} satisfies services.AddBatchJobOperationsRequest
		);
		return {
			nextSequenceToken: body.nextSequenceToken,
			totalOperations: Number(body.totalOperations ?? 0)
		};
	}

	/** Starts a batch job. Returns the long-running operation name; poll progress with `getBatchJob`. */
	async runBatchJob(batchJob: string): Promise<string | undefined> {
		const body = await this.#request<{ name?: string }>('POST', `/${batchJob}:run`, {});
		return body.name;
	}

	/** A batch job's status (PENDING, RUNNING, DONE) and progress metadata. */
	async getBatchJob(batchJob: string): Promise<resources.BatchJob | undefined> {
		const customerId = /^customers\/(\d+)\/batchJobs\/\d+$/.exec(batchJob)?.[1];
		if (!customerId) throw new GoogleAdsError(`Not a batch job resource name: '${batchJob}'.`);
		const [row] = await this.search(
			customerId,
			`SELECT batch_job.resource_name, batch_job.status, batch_job.long_running_operation,
				batch_job.metadata.operation_count, batch_job.metadata.executed_operation_count,
				batch_job.metadata.estimated_completion_ratio, batch_job.metadata.creation_date_time,
				batch_job.metadata.start_date_time, batch_job.metadata.completion_date_time
			FROM batch_job WHERE batch_job.resource_name = '${batchJob}'`
		);
		return row?.batchJob;
	}

	/** Every result of a finished batch job, one per operation, following pagination. */
	async listBatchJobResults(batchJob: string): Promise<services.BatchJobResult[]> {
		const results: services.BatchJobResult[] = [];
		let pageToken: string | undefined;
		do {
			const query = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
			const body = await this.#request<services.ListBatchJobResultsResponse>(
				'GET',
				`/${batchJob}:listResults?${query}`
			);
			results.push(...(body.results ?? []));
			pageToken = body.nextPageToken;
		} while (pageToken);
		return results;
	}

	/**
	 * Geo target constants matching location names (GeoTargetConstantService.SuggestGeoTargetConstants),
	 * e.g. for a location picker. Partial names work ("Mün" suggests Munich). `locale` translates the
	 * returned names; `countryCode` (ISO-3166-1 alpha-2) restricts results to one country.
	 */
	async suggestGeoTargetConstants(
		names: string[],
		{ locale = 'en', countryCode }: { locale?: string; countryCode?: string } = {}
	): Promise<services.GeoTargetConstantSuggestion[]> {
		if (!names.length)
			throw new GoogleAdsError('suggestGeoTargetConstants needs at least one name.');
		const body = await this.#request<services.SuggestGeoTargetConstantsResponse>(
			'POST',
			'/geoTargetConstants:suggest',
			{
				locale,
				countryCode,
				locationNames: { names }
			} satisfies services.SuggestGeoTargetConstantsRequest
		);
		return body.geoTargetConstantSuggestions ?? [];
	}

	/**
	 * Queries GAQL field metadata (GoogleAdsFieldService), e.g.
	 * `SELECT name, selectable, filterable, sortable WHERE name LIKE 'campaign.%'`.
	 */
	async searchFields(query: string): Promise<resources.GoogleAdsField[]> {
		const fields: resources.GoogleAdsField[] = [];
		let pageToken: string | undefined;
		do {
			const body = await this.#request<services.SearchGoogleAdsFieldsResponse>(
				'POST',
				'/googleAdsFields:search',
				{ query, pageToken } satisfies services.SearchGoogleAdsFieldsRequest
			);
			fields.push(...(body.results ?? []));
			pageToken = body.nextPageToken;
		} while (pageToken);
		return fields;
	}

	async #request<T>(method: 'GET' | 'POST', path: string, json?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${await this.#getAccessToken()}`,
			'x-goog-api-client': `gl-node/${process.versions.node} google-ads-rest`
		};
		if (this.#config.loginCustomerId) headers['login-customer-id'] = this.#config.loginCustomerId;
		if (json !== undefined) headers['content-type'] = 'application/json';

		const res = await this.#fetch(API_BASE + path, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		});
		const body = await res.json().catch(() => undefined);
		if (!res.ok)
			throw GoogleAdsError.fromResponse(res.status, body ?? { error: { message: res.statusText } });
		return body as T;
	}

	async #getAccessToken(): Promise<string> {
		if (this.#accessToken && this.#accessToken.expiresAt > Date.now() + 60_000) {
			return this.#accessToken.value;
		}

		const { clientId, clientSecret, refreshToken } = this.#config;
		const missing = Object.entries({
			GOOGLE_ADS_CLIENT_ID: clientId,
			GOOGLE_ADS_CLIENT_SECRET: clientSecret,
			GOOGLE_ADS_REFRESH_TOKEN: refreshToken
		})
			.filter(([, value]) => !value)
			.map(([name]) => name);
		if (missing.length)
			throw new GoogleAdsError(`Google Ads is not configured: ${missing.join(', ')} missing.`);

		const res = await this.#fetch(TOKEN_URL, {
			method: 'POST',
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				client_id: clientId!,
				client_secret: clientSecret!,
				refresh_token: refreshToken!
			})
		});
		const body = (await res.json().catch(() => undefined)) as TokenResponse | undefined;
		if (!res.ok || !body?.access_token) {
			const hint =
				body?.error === 'invalid_grant'
					? ' The refresh token expired or was revoked; run `npx @adginr/google-ads-mcp auth`.'
					: '';
			throw new GoogleAdsError(
				`OAuth token refresh failed: ${body?.error_description ?? body?.error ?? res.statusText}.${hint}`,
				{ status: res.status }
			);
		}

		this.#accessToken = {
			value: body.access_token,
			expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000
		};
		return this.#accessToken.value;
	}
}

/** OAuth token endpoint response (success or error). */
interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}
