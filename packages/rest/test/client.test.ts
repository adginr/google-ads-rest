import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsClient } from '../src/client.ts';
import { GoogleAdsError } from '../src/errors.ts';
import { fakeApi } from './fake-api.ts';

describe('GoogleAdsClient', () => {
	it('reports missing configuration before any network call', async () => {
		const fetchFn = vi.fn<typeof fetch>();
		const ads = new GoogleAdsClient({ clientId: 'id', fetch: fetchFn });
		await expect(ads.listAccessibleCustomers()).rejects.toThrow(
			'GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN missing'
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('refreshes the token once and reuses it', async () => {
		const fetchFn = vi.fn<typeof fetch>(async (input) =>
			String(input).includes('oauth2')
				? Response.json({ access_token: 'tok', expires_in: 3600 })
				: Response.json({ resourceNames: ['customers/1'] })
		);
		const ads = new GoogleAdsClient({
			clientId: 'a',
			clientSecret: 'b',
			refreshToken: 'c',
			fetch: fetchFn
		});
		await ads.listAccessibleCustomers();
		await ads.listAccessibleCustomers();
		expect(fetchFn.mock.calls.filter(([url]) => String(url).includes('oauth2'))).toHaveLength(1);
		const headers = fetchFn.mock.calls[1]![1]!.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer tok');
	});

	it('hints at re-auth when the refresh token is revoked', async () => {
		const ads = new GoogleAdsClient({
			clientId: 'a',
			clientSecret: 'b',
			refreshToken: 'c',
			fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 })
		});
		await expect(ads.listAccessibleCustomers()).rejects.toThrow('google-ads-mcp auth');
	});

	it('sends login-customer-id without dashes', async () => {
		const api = fakeApi({ loginCustomerId: '799-303-7647' });
		await api.ads.search('1234567890', 'SELECT campaign.id FROM campaign');
		expect(api.requests[0]!.headers['login-customer-id']).toBe('7993037647');
	});

	it('follows search pagination up to maxRows', async () => {
		let page = 0;
		const ads = new GoogleAdsClient({
			clientId: 'a',
			clientSecret: 'b',
			refreshToken: 'c',
			fetch: async (input) => {
				if (String(input).includes('oauth2'))
					return Response.json({ access_token: 't', expires_in: 3600 });
				page++;
				return Response.json({
					results: [{ campaign: { id: String(page) } }, { campaign: { id: `${page}b` } }],
					nextPageToken: page < 3 ? `p${page}` : undefined
				});
			}
		});
		expect(await ads.search('1', 'q')).toHaveLength(6);
		page = 0;
		expect(await ads.search('1', 'q', { maxRows: 3 })).toHaveLength(3);
		expect(page).toBe(2);
	});

	it('throws when mutate returns fewer results than operations', async () => {
		const api = fakeApi({ mutate: () => [] });
		await expect(
			api.ads.mutate('1', [{ campaignOperation: { remove: 'customers/1/campaigns/2' } }])
		).rejects.toThrow('Mutate returned 0 results for 1 operations');
	});

	it('does not require results for a validate-only mutate', async () => {
		const api = fakeApi();
		const results = await api.ads.mutate('1', [{ campaignOperation: { remove: 'x' } }], {
			validateOnly: true
		});
		expect(results).toEqual([]);
		expect(api.mutates[0]!.validateOnly).toBe(true);
	});

	it('rejects an empty mutate without calling the API', async () => {
		const api = fakeApi();
		await expect(api.ads.mutate('1', [])).rejects.toThrow('at least one operation');
		expect(api.requests).toHaveLength(0);
	});
});

describe('GoogleAdsError.fromResponse', () => {
	it('leads with GoogleAdsFailure entries', () => {
		const error = GoogleAdsError.fromResponse(400, {
			error: {
				message: 'Request contains an invalid argument.',
				status: 'INVALID_ARGUMENT',
				details: [
					{
						'@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
						requestId: 'req-1',
						errors: [
							{
								errorCode: { queryError: 'UNRECOGNIZED_FIELD' },
								message: "Unrecognized field 'campaign.nope'.",
								location: {
									fieldPathElements: [{ fieldName: 'operations', index: 0 }, { fieldName: 'name' }]
								}
							}
						]
					}
				]
			}
		});
		expect(error.message).toBe(
			"Google Ads API 400 INVALID_ARGUMENT: queryError.UNRECOGNIZED_FIELD: Unrecognized field 'campaign.nope'. (field: operations[0].name)"
		);
		expect(error.requestId).toBe('req-1');
		expect(error.errors[0]!.code).toBe('queryError.UNRECOGNIZED_FIELD');
	});

	it('falls back to the top-level message', () => {
		expect(GoogleAdsError.fromResponse(503, { error: { message: 'Unavailable' } }).message).toBe(
			'Google Ads API 503: Unavailable'
		);
	});
});
