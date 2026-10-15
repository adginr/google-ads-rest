/**
 * In-memory stand-in for the Google Ads REST API, injected through the client's `fetch` option.
 * Records every request so tests can assert the exact GAQL and mutate operations sent.
 */
import type { z } from 'zod';
import { GoogleAdsClient } from '../src/client.ts';
import type { AdsTool } from '../src/tools/define-tool.ts';
import type { services } from '../src/types/index.ts';

export interface RecordedRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | undefined;
}

export interface FakeApiOptions {
	/** Rows for a GAQL query; called once per googleAds:search request. */
	search?: (query: string) => services.GoogleAdsRow[];
	/** Responses for a mutate; defaults to one `<x>Result` with a fake resource name per operation. */
	mutate?: (
		operations: services.MutateOperation[],
		validateOnly: boolean
	) => services.MutateOperationResponse[];
	/** Anything else: return [status, body]. */
	other?: (request: RecordedRequest) => [number, unknown];
	loginCustomerId?: string;
}

export function fakeApi(options: FakeApiOptions = {}) {
	const requests: RecordedRequest[] = [];

	const fetchFn: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === 'oauth2.googleapis.com') {
			return Response.json({ access_token: 'test-token', expires_in: 3600 });
		}
		const request: RecordedRequest = {
			method: init?.method ?? 'GET',
			path: url.pathname.replace(/^\/v\d+/, ''),
			headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
			body: init?.body ? JSON.parse(String(init.body)) : undefined
		};
		requests.push(request);

		if (request.path.endsWith('/googleAds:search')) {
			return Response.json({ results: options.search?.(String(request.body?.query)) ?? [] });
		}
		if (request.path.endsWith('/googleAds:mutate')) {
			const operations = request.body?.mutateOperations as services.MutateOperation[];
			const validateOnly = Boolean(request.body?.validateOnly);
			if (validateOnly && !options.mutate) return Response.json({});
			const responses = options.mutate?.(operations, validateOnly) ?? operations.map(defaultResult);
			return Response.json({ mutateOperationResponses: responses });
		}
		const [status, body] = options.other?.(request) ?? [404, { error: { message: 'not faked' } }];
		return Response.json(body, { status });
	};

	const ads = new GoogleAdsClient({
		clientId: 'id',
		clientSecret: 'secret',
		refreshToken: 'refresh',
		loginCustomerId: options.loginCustomerId,
		fetch: fetchFn
	});

	return {
		ads,
		requests,
		/** GAQL queries sent, whitespace collapsed. */
		get queries() {
			return requests
				.filter((r) => r.path.endsWith('/googleAds:search'))
				.map((r) => String(r.body?.query).replace(/\s+/g, ' ').trim());
		},
		/** Operations of every mutate request, in order. */
		get mutates() {
			return requests
				.filter((r) => r.path.endsWith('/googleAds:mutate'))
				.map((r) => ({
					operations: r.body?.mutateOperations as services.MutateOperation[],
					validateOnly: Boolean(r.body?.validateOnly)
				}));
		},
		/** Parses input through the tool's schema (as adapters do), then runs it. */
		async call<T extends AdsTool>(tool: T, input: unknown): Promise<z.input<T['output']>> {
			return (await tool.run(tool.input.parse(input), { ads })) as z.input<T['output']>;
		}
	};
}

let counter = 100;

/** `{ campaignOperation: … }` → `{ campaignResult: { resourceName } }`. */
function defaultResult(operation: services.MutateOperation): services.MutateOperationResponse {
	const [key, op] = Object.entries(operation)[0] as [
		string,
		{ create?: unknown; update?: { resourceName?: string }; remove?: string }
	];
	const kind = key.replace(/Operation$/, '');
	const collection = `${kind}s`.replace(/ys$/, 'ies').replace(/Criterions$/, 'Criteria');
	const resourceName =
		op.remove ??
		op.update?.resourceName ??
		`customers/1234567890/${collection}/${kind === 'adGroupCriterion' || kind === 'adGroupAd' ? `555~${counter++}` : counter++}`;
	return { [`${kind}Result`]: { resourceName } } as services.MutateOperationResponse;
}
