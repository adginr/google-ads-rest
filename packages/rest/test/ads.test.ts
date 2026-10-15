import { describe, expect, it } from 'vitest';
import { createResponsiveSearchAd, listAdsInAdGroup, updateAdStatus } from '../src/tools/index.ts';
import { fakeApi } from './fake-api.ts';

const valid = {
	customerId: '1234567890',
	adGroupId: '555',
	headlines: ['Lease a Porsche', 'Dubai Car Leasing', 'Flexible Terms'],
	descriptions: ['Drive a new Porsche this week.', 'Monthly plans with insurance included.'],
	finalUrls: ['https://example.com/porsche']
};

describe('create_responsive_search_ad', () => {
	it('creates a PAUSED RSA with pins only where set', async () => {
		const api = fakeApi();
		const result = await api.call(createResponsiveSearchAd, {
			...valid,
			headlinePins: ['1', null, 'none'],
			path1: 'porsche'
		});
		const create = api.mutates[0]!.operations[0]!.adGroupAdOperation!.create!;
		expect(create.status).toBe('PAUSED');
		expect(create.ad!.responsiveSearchAd!.headlines).toEqual([
			{ text: 'Lease a Porsche', pinnedField: 'HEADLINE_1' },
			{ text: 'Dubai Car Leasing' },
			{ text: 'Flexible Terms' }
		]);
		expect(create.ad!.responsiveSearchAd!.path1).toBe('porsche');
		expect(create.ad!.responsiveSearchAd).not.toHaveProperty('path2');
		expect(result.warnings).toEqual([
			expect.stringContaining('only 1 headline is pinned to HEADLINE_1')
		]);
		expect(result.adId).toMatch(/^\d+$/);
	});

	it.each([
		[{ headlines: ['a', 'b'] }, ''],
		[{ headlines: ['a', 'b', 'x'.repeat(31)] }, '30 characters'],
		[{ headlines: ['Same', 'same', 'c'] }, 'duplicate headline'],
		[{ headlines: ['a\nb', 'b', 'c'] }, 'line breaks'],
		[{ descriptions: ['only one'] }, ''],
		[{ finalUrls: ['example.com/x'] }, 'absolute http(s) URL'],
		[{ finalUrls: ['https://localhost/x'] }, 'absolute http(s) URL'],
		[{ finalUrls: ['https://example.com/car leasing'] }, 'absolute http(s) URL'],
		[{ finalUrls: ['javascript:alert(1)'] }, 'absolute http(s) URL'],
		[{ headlinePins: ['HEADLINE_1'] }, 'exactly one entry per asset'],
		[{ headlinePins: ['4', null, null] }, ''],
		[{ descriptionPins: ['HEADLINE_1', null] }, ''],
		[{ path2: 'only-two' }, 'path2 requires path1'],
		[{ path1: 'two words' }, 'one segment'],
		[{ path1: 'a/b' }, 'one segment'],
		[{ status: 'REMOVED' }, ''],
		[{ validateOnly: 'false' }, '']
	])('rejects %j before any request', async (override, message) => {
		const api = fakeApi();
		await expect(api.call(createResponsiveSearchAd, { ...valid, ...override })).rejects.toThrow(
			message
		);
		expect(api.requests).toHaveLength(0);
	});

	it('warns when everything is pinned', async () => {
		const api = fakeApi();
		const result = await api.call(createResponsiveSearchAd, {
			...valid,
			headlinePins: ['HEADLINE_1', 'HEADLINE_1', 'HEADLINE_2'],
			validateOnly: true
		});
		expect(result.warnings).toEqual([
			expect.stringContaining('only 1 headline is pinned to HEADLINE_2'),
			expect.stringContaining('all 3 headlines are pinned')
		]);
		expect(result.ad).toBeNull();
	});
});

describe('update_ad_status', () => {
	it('uses remove for REMOVED', async () => {
		const api = fakeApi();
		await api.call(updateAdStatus, {
			customerId: '1234567890',
			adGroupId: '555',
			adId: '222',
			status: 'REMOVED'
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			adGroupAdOperation: { remove: 'customers/1234567890/adGroupAds/555~222' }
		});
	});

	it('uses an update for PAUSED', async () => {
		const api = fakeApi();
		await api.call(updateAdStatus, {
			customerId: '1234567890',
			adGroupId: '555',
			adId: '222',
			status: 'PAUSED'
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			adGroupAdOperation: {
				update: { resourceName: 'customers/1234567890/adGroupAds/555~222', status: 'PAUSED' },
				updateMask: 'status'
			}
		});
	});

	it('rejects composite ad IDs', async () => {
		const api = fakeApi();
		await expect(
			api.call(updateAdStatus, {
				customerId: '1234567890',
				adGroupId: '555',
				adId: '22~2',
				status: 'PAUSED'
			})
		).rejects.toThrow('digits only');
	});
});

describe('list_ads_in_ad_group', () => {
	it('returns copy with valid pins only and hides removed ads by default', async () => {
		const api = fakeApi({
			search: () => [
				{
					adGroupAd: {
						resourceName: 'customers/1234567890/adGroupAds/555~222',
						status: 'ENABLED',
						adStrength: 'GOOD',
						ad: {
							id: '222',
							type: 'RESPONSIVE_SEARCH_AD',
							finalUrls: ['https://example.com'],
							responsiveSearchAd: {
								headlines: [
									{ text: 'A', pinnedField: 'HEADLINE_1' },
									{ text: 'B', pinnedField: 'UNSPECIFIED' }
								],
								descriptions: [{ text: 'D' }],
								path1: 'x'
							}
						}
					}
				},
				{
					adGroupAd: {
						resourceName: 'customers/1234567890/adGroupAds/555~333',
						ad: { type: 'EXPANDED_TEXT_AD' }
					}
				}
			]
		});
		const { ads } = await api.call(listAdsInAdGroup, {
			customerId: '1234567890',
			adGroupId: '555'
		});
		expect(api.queries[0]).toContain("ad_group_ad.status != 'REMOVED'");
		expect(api.queries[0]).toContain('LIMIT 50');
		expect(ads[0]).toMatchObject({
			adId: '222',
			headlines: [
				{ text: 'A', pin: 'HEADLINE_1' },
				{ text: 'B', pin: null }
			],
			path1: 'x',
			path2: null
		});
		expect(ads[1]).toMatchObject({ adId: '333', headlines: [], descriptions: [] });
	});
});
