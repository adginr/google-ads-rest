import { describe, expect, it } from 'vitest';
import {
	adsTools,
	attachCalloutsToCampaign,
	createCallouts,
	createSitelinks,
	generateKeywordIdeas,
	getResourceMetadata,
	listCallouts,
	listSitelinks,
	removeCalloutLinks,
	search,
	updateSitelinkLinkStatus
} from '../src/tools/index.ts';
import { fakeApi } from './fake-api.ts';

const customerId = '1234567890';

describe('search', () => {
	it('builds the query and returns rows keyed by requested fields', async () => {
		const api = fakeApi({
			search: () => [{ campaign: { id: '9', name: 'Brand' }, metrics: { costMicros: '1500000' } }]
		});
		const result = await api.call(search, {
			customerId,
			resource: 'campaign',
			fields: ['campaign.id', 'campaign.name', 'metrics.cost_micros', 'metrics.clicks'],
			conditions: ["campaign.status = 'ENABLED'"],
			orderings: ['campaign.name asc'],
			limit: 10
		});
		expect(result.query).toBe(
			"SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' " +
				'ORDER BY campaign.name ASC LIMIT 10 PARAMETERS omit_unselected_resource_names=true'
		);
		expect(result.rows).toEqual([
			{
				'campaign.id': '9',
				'campaign.name': 'Brand',
				'metrics.cost_micros': '1500000',
				'metrics.clicks': null
			}
		]);
	});

	it.each([
		[{ fields: ['id'] }, 'full field name'],
		[{ resource: 'Campaign' }, 'resource name'],
		[{ conditions: ['campaign.id = 1 LIMIT 5'] }, 'clause keyword LIMIT'],
		[{ orderings: ['campaign.id SIDEWAYS'] }, "must be '<field> [ASC|DESC]'"],
		[
			{ resource: 'change_event', fields: ['change_event.change_date_time'] },
			'limit of at most 10000'
		],
		[{ limit: 10_001 }, '']
	])('rejects %j before any request', async (override, message) => {
		const api = fakeApi();
		await expect(
			api.call(search, { customerId, resource: 'campaign', fields: ['campaign.id'], ...override })
		).rejects.toThrow(message);
		expect(api.requests).toHaveLength(0);
	});

	it('lists every GAQL resource in its description', () => {
		expect(search.description).toContain('ad_group_criterion');
		expect(search.description).toContain('search_term_view');
	});
});

describe('get_resource_metadata', () => {
	it('returns own fields plus compatible segments and metrics', async () => {
		const api = fakeApi({
			other: (request) => {
				const query = String(request.body?.query);
				return query.includes('LIKE')
					? [
							200,
							{
								results: [
									{ name: 'campaign.name', selectable: true, filterable: true, sortable: true },
									{ name: 'campaign.id', selectable: true, filterable: true, sortable: false }
								]
							}
						]
					: [
							200,
							{
								results: [
									{ name: 'campaign', segments: ['segments.date'], metrics: ['metrics.clicks'] }
								]
							}
						];
			}
		});
		const result = await api.call(getResourceMetadata, { resource: 'campaign' });
		expect(api.requests.map((r) => r.body?.query)).toContain(
			"SELECT name, selectable, filterable, sortable WHERE name LIKE 'campaign.%'"
		);
		expect(result).toMatchObject({
			selectable: ['campaign.id', 'campaign.name'],
			sortable: ['campaign.name'],
			segments: ['segments.date'],
			metrics: ['metrics.clicks']
		});
	});
});

describe('generate_keyword_ideas', () => {
	it('picks the seed type and converts metrics', async () => {
		const api = fakeApi({
			other: () => [
				200,
				{
					results: [
						{
							text: 'car lease',
							keywordIdeaMetrics: {
								avgMonthlySearches: '1300',
								competition: 'HIGH',
								lowTopOfPageBidMicros: '1200000'
							}
						}
					]
				}
			]
		});
		const { ideas } = await api.call(generateKeywordIdeas, {
			customerId,
			keywords: ['car lease'],
			locationIds: [2784],
			languageId: 1000
		});
		expect(api.requests[0]!.path).toBe('/customers/1234567890:generateKeywordIdeas');
		expect(api.requests[0]!.body).toMatchObject({
			keywordSeed: { keywords: ['car lease'] },
			geoTargetConstants: ['geoTargetConstants/2784'],
			language: 'languageConstants/1000'
		});
		expect(ideas[0]).toEqual({
			keyword: 'car lease',
			avgMonthlySearches: 1300,
			competition: 'HIGH',
			competitionIndex: null,
			lowTopOfPageBid: 1.2,
			highTopOfPageBid: null
		});
	});

	it('needs keywords or a page', async () => {
		const api = fakeApi();
		await expect(api.call(generateKeywordIdeas, { customerId })).rejects.toThrow(
			'keywords, pageUrl, or both'
		);
	});
});

describe('callouts', () => {
	it('lists campaign callouts with parsed IDs', async () => {
		const api = fakeApi({
			search: () => [
				{
					campaignAsset: {
						resourceName: 'customers/1234567890/campaignAssets/9~44~CALLOUT',
						status: 'ENABLED',
						primaryStatus: 'ELIGIBLE'
					},
					campaign: { id: '9', name: 'Brand' },
					asset: { calloutAsset: { calloutText: 'Free delivery' } }
				}
			]
		});
		const { callouts } = await api.call(listCallouts, {
			customerId,
			level: 'campaign',
			campaignId: '9'
		});
		expect(api.queries[0]).toContain("campaign_asset.field_type = 'CALLOUT' AND campaign.id = 9");
		expect(callouts[0]).toMatchObject({
			assetId: '44',
			asset: 'customers/1234567890/assets/44',
			campaignId: '9',
			text: 'Free delivery'
		});
	});

	it('creates callouts with dates and validates them', async () => {
		const api = fakeApi();
		await api.call(createCallouts, {
			customerId,
			texts: ['Free delivery'],
			startDate: '2026-11-01'
		});
		expect(api.mutates[0]!.operations[0]!.assetOperation!.create).toEqual({
			name: 'Callout: Free delivery',
			calloutAsset: { calloutText: 'Free delivery', startDate: '2026-11-01' }
		});
		await expect(api.call(createCallouts, { customerId, texts: ['x'.repeat(26)] })).rejects.toThrow(
			'25 characters'
		);
		await expect(api.call(createCallouts, { customerId, texts: ['A', 'a'] })).rejects.toThrow(
			'duplicate'
		);
		await expect(
			api.call(createCallouts, { customerId, texts: ['A'], startDate: '2026-02-30' })
		).rejects.toThrow('calendar date');
		await expect(
			api.call(createCallouts, {
				customerId,
				texts: ['A'],
				startDate: '2026-03-02',
				endDate: '2026-03-01'
			})
		).rejects.toThrow('on or before');
	});

	it('attaches by asset ID or resource name', async () => {
		const api = fakeApi();
		await api.call(attachCalloutsToCampaign, {
			customerId,
			campaignId: '9',
			assets: ['44', 'customers/1234567890/assets/45']
		});
		expect(api.mutates[0]!.operations.map((o) => o.campaignAssetOperation!.create!.asset)).toEqual([
			'customers/1234567890/assets/44',
			'customers/1234567890/assets/45'
		]);
		expect(api.mutates[0]!.operations[0]!.campaignAssetOperation!.create).toMatchObject({
			campaign: 'customers/1234567890/campaigns/9',
			fieldType: 'CALLOUT',
			status: 'ENABLED'
		});
	});

	it('refuses link names of another level', async () => {
		const api = fakeApi();
		await expect(
			api.call(removeCalloutLinks, {
				customerId,
				level: 'ACCOUNT',
				links: ['customers/1234567890/campaignAssets/9~44~CALLOUT']
			})
		).rejects.toThrow('is not a ACCOUNT link');
		expect(api.requests).toHaveLength(0);
	});
});

describe('sitelinks', () => {
	it('requires both descriptions or neither', async () => {
		const api = fakeApi();
		await expect(
			api.call(createSitelinks, {
				customerId,
				sitelinks: [
					{ linkText: 'Pricing', finalUrl: 'https://example.com/p', description1: 'Only one' }
				]
			})
		).rejects.toThrow('both description1 and description2');
	});

	it('creates sitelink assets with the URL on the asset', async () => {
		const api = fakeApi();
		await api.call(createSitelinks, {
			customerId,
			sitelinks: [{ linkText: 'Pricing', finalUrl: 'https://example.com/p' }]
		});
		expect(api.mutates[0]!.operations[0]!.assetOperation!.create).toEqual({
			name: 'Sitelink: Pricing',
			finalUrls: ['https://example.com/p'],
			sitelinkAsset: { linkText: 'Pricing' }
		});
	});

	it('only filters by ad group at AD_GROUP level', async () => {
		const api = fakeApi();
		await expect(
			api.call(listSitelinks, { customerId, level: 'CAMPAIGN', adGroupId: '5' })
		).rejects.toThrow('only be used when level is AD_GROUP');
	});

	it('updates link status with a status mask', async () => {
		const api = fakeApi();
		const link = 'customers/1234567890/adGroupAssets/5~44~SITELINK';
		const result = await api.call(updateSitelinkLinkStatus, {
			customerId,
			level: 'AD_GROUP',
			links: [link],
			status: 'paused'
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			adGroupAssetOperation: {
				update: { resourceName: link, status: 'PAUSED' },
				updateMask: 'status'
			}
		});
		expect(result.links[0]).toMatchObject({
			adGroupId: '5',
			asset: 'customers/1234567890/assets/44'
		});
	});
});

describe('registry', () => {
	it('has unique snake_case names and mutations support validateOnly', () => {
		const names = adsTools.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.every((name) => /^[a-z]+(_[a-z]+)*$/.test(name))).toBe(true);
		for (const tool of adsTools.filter((t) => !t.annotations.readOnly)) {
			expect(Object.keys(tool.input.shape), tool.name).toContain('validateOnly');
		}
		expect(adsTools).toHaveLength(30);
	});
});
