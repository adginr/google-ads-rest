import { describe, expect, it } from 'vitest';
import { getCampaignSnapshot } from '../src/tools/index.ts';
import type { services } from '../src/types/index.ts';
import { fakeApi } from './fake-api.ts';

const customerId = '1234567890';

/** One canned response per GAQL resource (the text after FROM). */
const rows: Record<string, services.GoogleAdsRow[]> = {
	campaign: [
		{
			campaign: {
				id: '9',
				name: 'Sofas',
				status: 'PAUSED',
				advertisingChannelType: 'SEARCH',
				biddingStrategyType: 'TARGET_SPEND',
				targetSpend: { cpcBidCeilingMicros: '3000000' },
				networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false },
				geoTargetTypeSetting: {
					positiveGeoTargetType: 'PRESENCE',
					negativeGeoTargetType: 'PRESENCE'
				},
				startDateTime: '2026-11-01 00:00:00',
				endDateTime: '2026-12-31 23:59:59',
				containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'
			},
			campaignBudget: {
				id: '4',
				name: 'Sofas budget',
				amountMicros: '50000000',
				referenceCount: '1',
				deliveryMethod: 'STANDARD'
			},
			customer: { currencyCode: 'AED', timeZone: 'Asia/Dubai' }
		}
	],
	campaign_criterion: [
		{
			campaignCriterion: {
				type: 'LOCATION',
				location: { geoTargetConstant: 'geoTargetConstants/2784' }
			}
		},
		{
			campaignCriterion: {
				type: 'LOCATION',
				negative: true,
				location: { geoTargetConstant: 'geoTargetConstants/2004' }
			}
		},
		{
			campaignCriterion: {
				type: 'PROXIMITY',
				proximity: {
					radius: 8,
					radiusUnits: 'KILOMETERS',
					geoPoint: { latitudeInMicroDegrees: 25050458, longitudeInMicroDegrees: 55198915 }
				}
			}
		},
		{
			campaignCriterion: {
				type: 'LANGUAGE',
				language: { languageConstant: 'languageConstants/1000' }
			}
		},
		{ campaignCriterion: { type: 'DEVICE', device: { type: 'MOBILE' }, bidModifier: 1.2 } },
		{
			campaignCriterion: {
				type: 'AD_SCHEDULE',
				adSchedule: { dayOfWeek: 'MONDAY', startHour: 9, endHour: 21, endMinute: 'THIRTY' }
			}
		},
		{
			campaignCriterion: {
				type: 'KEYWORD',
				negative: true,
				keyword: { text: 'diy', matchType: 'PHRASE' }
			}
		}
	],
	ad_group: [
		{
			adGroup: {
				id: '5',
				name: 'Outdoor',
				status: 'ENABLED',
				type: 'SEARCH_STANDARD',
				cpcBidMicros: '1500000'
			}
		}
	],
	ad_group_criterion: [
		{
			adGroup: { id: '5' },
			adGroupCriterion: {
				criterionId: '11',
				status: 'ENABLED',
				keyword: { text: 'outdoor sofa', matchType: 'PHRASE' },
				cpcBidMicros: '2000000'
			}
		},
		{
			adGroup: { id: '5' },
			adGroupCriterion: {
				criterionId: '12',
				negative: true,
				keyword: { text: 'cheap', matchType: 'BROAD' }
			}
		},
		{
			adGroup: { id: '999' },
			adGroupCriterion: { criterionId: '13', keyword: { text: 'orphan', matchType: 'EXACT' } }
		}
	],
	ad_group_ad: [
		{
			adGroup: { id: '5' },
			adGroupAd: {
				status: 'PAUSED',
				adStrength: 'GOOD',
				ad: {
					id: '77',
					type: 'RESPONSIVE_SEARCH_AD',
					finalUrls: ['https://example.com/'],
					responsiveSearchAd: {
						headlines: [
							{ text: 'Outdoor Sofas', pinnedField: 'HEADLINE_1' },
							{ text: 'Free Delivery' }
						],
						descriptions: [{ text: 'Weatherproof.' }],
						path1: 'sofas'
					}
				}
			}
		}
	],
	campaign_shared_set: [{ sharedSet: { id: '40', name: 'Common' } }],
	shared_criterion: [
		{ sharedSet: { id: '40' }, sharedCriterion: { keyword: { text: 'free', matchType: 'BROAD' } } }
	],
	geo_target_constant: [
		{
			geoTargetConstant: {
				id: '2784',
				name: 'United Arab Emirates',
				canonicalName: 'United Arab Emirates',
				targetType: 'Country'
			}
		}
	],
	language_constant: [{ languageConstant: { id: '1000', name: 'English', code: 'en' } }],
	campaign_asset: [
		{
			campaignAsset: { fieldType: 'SITELINK', status: 'ENABLED' },
			asset: {
				id: '61',
				finalUrls: ['https://example.com/a'],
				sitelinkAsset: { linkText: 'Lamps' }
			}
		},
		{
			campaignAsset: { fieldType: 'STRUCTURED_SNIPPET', status: 'ENABLED' },
			asset: { id: '62', structuredSnippetAsset: { header: 'Types', values: ['Sofas', 'Chairs'] } }
		}
	],
	ad_group_asset: [
		{
			adGroup: { id: '5' },
			adGroupAsset: { fieldType: 'CALLOUT', status: 'PAUSED' },
			asset: { id: '63', calloutAsset: { calloutText: 'Free delivery' } }
		}
	]
};

function snapshotApi(overrides: Record<string, services.GoogleAdsRow[]> = {}) {
	return fakeApi({
		search: (query) => {
			const resource = /FROM\s+(\w+)/.exec(query)![1]!;
			return { ...rows, ...overrides }[resource] ?? [];
		}
	});
}

describe('get_campaign_snapshot', () => {
	it('assembles settings, targeting, ad groups, negatives and assets', async () => {
		const api = snapshotApi();
		const snapshot = await api.call(getCampaignSnapshot, {
			customerId: '123-456-7890',
			campaignId: '9'
		});
		expect(getCampaignSnapshot.output.parse(snapshot)).toEqual(snapshot);
		expect(api.queries.every((q) => /campaign\.id = 9|\.id IN \(/.test(q))).toBe(true);
		expect(snapshot.campaign).toMatchObject({
			bidding: {
				strategy: 'TARGET_SPEND',
				maxCpcBidCeiling: 3,
				targetCpa: null,
				enhancedCpc: null
			},
			networks: { googleSearch: true, searchPartners: false, displayNetwork: false },
			locationTargeting: 'PRESENCE',
			startDate: '2026-11-01',
			endDate: '2026-12-31',
			containsEuPoliticalAdvertising: false
		});
		expect(snapshot.budget).toEqual({
			id: '4',
			name: 'Sofas budget',
			dailyAmount: 50,
			explicitlyShared: false,
			sharedByCampaigns: 1,
			deliveryMethod: 'STANDARD'
		});
		expect(snapshot.targeting).toEqual({
			locations: [
				{
					id: 2784,
					name: 'United Arab Emirates',
					canonicalName: 'United Arab Emirates',
					targetType: 'Country',
					bidModifier: null
				}
			],
			excludedLocations: [
				{ id: 2004, name: null, canonicalName: null, targetType: null, bidModifier: null }
			],
			radius: [
				{
					latitude: 25.050458,
					longitude: 55.198915,
					radius: 8,
					radiusUnits: 'KILOMETERS',
					address: null,
					negative: false,
					bidModifier: null
				}
			],
			languages: [{ id: 1000, name: 'English', code: 'en' }],
			devices: [{ device: 'MOBILE', bidModifier: 1.2 }],
			adSchedule: [
				{
					dayOfWeek: 'MONDAY',
					startHour: 9,
					startMinute: 0,
					endHour: 21,
					endMinute: 30,
					bidModifier: null
				}
			]
		});
		expect(snapshot.negatives).toEqual({
			campaign: [{ text: 'diy', matchType: 'PHRASE' }],
			sharedLists: [
				{ listId: '40', name: 'Common', keywords: [{ text: 'free', matchType: 'BROAD' }] }
			]
		});
		expect(snapshot.adGroups).toEqual([
			{
				id: '5',
				name: 'Outdoor',
				status: 'ENABLED',
				type: 'SEARCH_STANDARD',
				cpcBid: 1.5,
				keywords: [
					{
						criterionId: '11',
						text: 'outdoor sofa',
						matchType: 'PHRASE',
						status: 'ENABLED',
						cpcBid: 2,
						finalUrl: null
					}
				],
				negatives: [{ text: 'cheap', matchType: 'BROAD' }],
				ads: [
					{
						adId: '77',
						status: 'PAUSED',
						type: 'RESPONSIVE_SEARCH_AD',
						adStrength: 'GOOD',
						headlines: [
							{ text: 'Outdoor Sofas', pin: 'HEADLINE_1' },
							{ text: 'Free Delivery', pin: null }
						],
						descriptions: [{ text: 'Weatherproof.', pin: null }],
						finalUrls: ['https://example.com/'],
						path1: 'sofas',
						path2: null
					}
				],
				assets: {
					sitelinks: [],
					callouts: [{ assetId: '63', status: 'PAUSED', text: 'Free delivery' }],
					structuredSnippets: []
				}
			}
		]);
		expect(snapshot.assets).toEqual({
			sitelinks: [
				{
					assetId: '61',
					status: 'ENABLED',
					linkText: 'Lamps',
					description1: null,
					description2: null,
					finalUrl: 'https://example.com/a'
				}
			],
			callouts: [],
			structuredSnippets: [
				{ assetId: '62', status: 'ENABLED', header: 'Types', values: ['Sofas', 'Chairs'] }
			]
		});
	});

	it('skips lookups that have nothing to look up', async () => {
		const api = snapshotApi({ campaign_criterion: [], campaign_shared_set: [] });
		const snapshot = await api.call(getCampaignSnapshot, { customerId, campaignId: '9' });
		expect(
			api.queries.some((q) =>
				/FROM (geo_target_constant|language_constant|shared_criterion)/.test(q)
			)
		).toBe(false);
		expect(snapshot.targeting.locations).toEqual([]);
		expect(snapshot.negatives.sharedLists).toEqual([]);
	});

	it('fails clearly for an unknown campaign and validates the ID first', async () => {
		await expect(
			snapshotApi({ campaign: [] }).call(getCampaignSnapshot, { customerId, campaignId: '9' })
		).rejects.toThrow('Campaign 9 not found.');
		const api = snapshotApi();
		await expect(
			api.call(getCampaignSnapshot, { customerId, campaignId: '9 OR 1=1' })
		).rejects.toThrow('digits only');
		expect(api.requests).toHaveLength(0);
	});
});
