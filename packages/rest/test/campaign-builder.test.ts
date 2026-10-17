import { describe, expect, it } from 'vitest';
import {
	campaignBudgetOperation,
	keywordOperation,
	MAX_MUTATE_OPERATIONS,
	MutatePlan,
	searchCampaignOperation
} from '../src/index.ts';
import {
	addKeywordsToNegativeKeywordList,
	attachNegativeKeywordList,
	createCampaignBudget,
	createNegativeKeywordList,
	createSearchCampaign,
	detachNegativeKeywordList,
	removeKeywordsFromNegativeKeywordList,
	updateAdGroup,
	updateCampaign,
	updateKeywordStatus
} from '../src/tools/index.ts';
import type { services } from '../src/types/index.ts';
import { fakeApi } from './fake-api.ts';

const customerId = '1234567890';
const c = (path: string) => `customers/${customerId}/${path}`;

const campaignBase = {
	customerId,
	name: 'Outdoor sofas',
	dailyBudget: 50,
	bidding: 'MAXIMIZE_CLICKS',
	containsEuPoliticalAdvertising: false
};

describe('create_search_campaign', () => {
	it('creates budget, campaign and targeting in one atomic request, paused and Search only', async () => {
		const api = fakeApi();
		const result = await api.call(createSearchCampaign, {
			...campaignBase,
			maxCpcBidCeiling: 3,
			startDate: '2026-11-01',
			endDate: '2026-12-31',
			locationIds: [2784],
			excludedLocationIds: [1000002],
			languageIds: [1000, 1019]
		});
		expect(api.mutates).toHaveLength(1);
		const [budget, campaign, ...criteria] = api.mutates[0]!.operations;
		expect(budget).toEqual({
			campaignBudgetOperation: {
				create: {
					resourceName: c('campaignBudgets/-1'),
					name: 'Outdoor sofas budget',
					amountMicros: '50000000',
					deliveryMethod: 'STANDARD',
					explicitlyShared: false
				}
			}
		});
		expect(campaign).toEqual({
			campaignOperation: {
				create: {
					resourceName: c('campaigns/-2'),
					name: 'Outdoor sofas',
					advertisingChannelType: 'SEARCH',
					status: 'PAUSED',
					campaignBudget: c('campaignBudgets/-1'),
					targetSpend: { cpcBidCeilingMicros: '3000000' },
					networkSettings: {
						targetGoogleSearch: true,
						targetSearchNetwork: false,
						targetPartnerSearchNetwork: false,
						targetContentNetwork: false
					},
					geoTargetTypeSetting: {
						positiveGeoTargetType: 'PRESENCE',
						negativeGeoTargetType: 'PRESENCE'
					},
					containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
					startDateTime: '2026-11-01 00:00:00',
					endDateTime: '2026-12-31 23:59:59'
				}
			}
		});
		expect(criteria.map((op) => op.campaignCriterionOperation?.create)).toEqual([
			{ campaign: c('campaigns/-2'), location: { geoTargetConstant: 'geoTargetConstants/2784' } },
			{
				campaign: c('campaigns/-2'),
				negative: true,
				location: { geoTargetConstant: 'geoTargetConstants/1000002' }
			},
			{ campaign: c('campaigns/-2'), language: { languageConstant: 'languageConstants/1000' } },
			{ campaign: c('campaigns/-2'), language: { languageConstant: 'languageConstants/1019' } }
		]);
		expect(result).toMatchObject({
			status: 'PAUSED',
			targeting: { locations: 1, excludedLocations: 1, languages: 2 },
			warnings: [],
			validateOnly: false
		});
		expect(result.campaignId).toMatch(/^\d+$/);
		expect(result.budgetId).toMatch(/^\d+$/);
	});

	it('uses an existing budget, maps bidding options and returns nulls on a dry run', async () => {
		const api = fakeApi();
		const result = await api.call(createSearchCampaign, {
			...campaignBase,
			dailyBudget: undefined,
			budgetId: '77',
			bidding: 'maximize_conversions',
			targetCpa: 25.5,
			includeSearchPartners: true,
			validateOnly: true
		});
		const { operations, validateOnly } = api.mutates[0]!;
		expect(validateOnly).toBe(true);
		expect(operations).toHaveLength(1);
		expect(operations[0]!.campaignOperation?.create).toMatchObject({
			campaignBudget: c('campaignBudgets/77'),
			maximizeConversions: { targetCpaMicros: '25500000' },
			networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true }
		});
		expect(result).toMatchObject({
			campaign: null,
			campaignId: null,
			budget: c('campaignBudgets/77'),
			budgetId: '77',
			validateOnly: true
		});
		expect(result.warnings).toEqual([
			'No locationIds: the campaign targets every country and territory.',
			'No languageIds: the campaign targets all languages.'
		]);
	});

	it('starts manual CPC without enhanced CPC and warns about ad group bids', async () => {
		const api = fakeApi();
		const result = await api.call(createSearchCampaign, {
			...campaignBase,
			bidding: 'MANUAL_CPC',
			locationIds: [2784],
			languageIds: [1000]
		});
		expect(api.mutates[0]!.operations[1]!.campaignOperation?.create?.manualCpc).toEqual({
			enhancedCpcEnabled: false
		});
		expect(result.warnings).toEqual([
			'MANUAL_CPC needs a cpcBid on each ad group (create_ad_group) or keyword.'
		]);
	});

	it.each([
		[{ budgetId: '77' }, 'exactly one of dailyBudget'],
		[{ dailyBudget: undefined }, 'exactly one of dailyBudget'],
		[{ containsEuPoliticalAdvertising: undefined }, 'containsEuPoliticalAdvertising'],
		[{ containsEuPoliticalAdvertising: 'false' }, 'containsEuPoliticalAdvertising'],
		[{ bidding: undefined }, 'bidding'],
		[{ bidding: 'TARGET_ROAS' }, 'bidding'],
		[{ targetCpa: 10 }, 'targetCpa applies only'],
		[{ bidding: 'MANUAL_CPC', maxCpcBidCeiling: 2 }, 'maxCpcBidCeiling applies only'],
		[{ startDate: '2026-12-01', endDate: '2026-11-01' }, 'on or before endDate'],
		[{ startDate: '2026-02-30' }, 'real calendar date'],
		[{ locationIds: [2784], excludedLocationIds: [2784] }, 'both targeted and excluded'],
		[{ locationIds: [2784, 2784] }, 'duplicate'],
		[{ status: 'REMOVED' }, 'status'],
		[{ includeDisplayNetwork: 'true' }, 'includeDisplayNetwork'],
		[{ dailyBudget: 0 }, 'dailyBudget']
	])('rejects %j before any request', async (override, message) => {
		const api = fakeApi();
		await expect(api.call(createSearchCampaign, { ...campaignBase, ...override })).rejects.toThrow(
			message
		);
		expect(api.requests).toHaveLength(0);
	});
});

describe('create_campaign_budget', () => {
	it('creates a budget in micros and needs an explicit sharing choice', async () => {
		const api = fakeApi();
		const result = await api.call(createCampaignBudget, {
			customerId,
			name: 'Shared',
			dailyBudget: 12.34,
			explicitlyShared: true
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			campaignBudgetOperation: {
				create: {
					name: 'Shared',
					amountMicros: '12340000',
					deliveryMethod: 'STANDARD',
					explicitlyShared: true
				}
			}
		});
		expect(result).toMatchObject({ dailyBudget: 12.34, explicitlyShared: true });
		expect(result.budgetId).toMatch(/^\d+$/);
		await expect(
			api.call(createCampaignBudget, { customerId, name: 'X', dailyBudget: 5 })
		).rejects.toThrow('explicitlyShared');
	});
});

describe('update tools', () => {
	it('renames a campaign and switches bidding with a subfield mask', async () => {
		const api = fakeApi();
		const result = await api.call(updateCampaign, {
			customerId,
			campaignId: '9',
			name: 'Renamed',
			bidding: 'MAXIMIZE_CONVERSIONS'
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			campaignOperation: {
				update: { resourceName: c('campaigns/9'), name: 'Renamed', maximizeConversions: {} },
				updateMask: 'name,maximizeConversions.targetCpaMicros'
			}
		});
		expect(result.updated).toEqual(['name', 'bidding']);
	});

	it('updates an ad group name and bid, and keyword statuses', async () => {
		const api = fakeApi();
		await api.call(updateAdGroup, { customerId, adGroupId: '5', cpcBid: 1.5 });
		await api.call(updateKeywordStatus, {
			customerId,
			adGroupId: '5',
			criterionIds: ['11', '12'],
			status: 'paused'
		});
		expect(api.mutates.map((m) => m.operations)).toEqual([
			[
				{
					adGroupOperation: {
						update: { resourceName: c('adGroups/5'), cpcBidMicros: '1500000' },
						updateMask: 'cpcBidMicros'
					}
				}
			],
			['11', '12'].map((id) => ({
				adGroupCriterionOperation: {
					update: { resourceName: c(`adGroupCriteria/5~${id}`), status: 'PAUSED' },
					updateMask: 'status'
				}
			}))
		]);
	});

	it.each([
		[updateCampaign, { campaignId: '9' }, 'name, bidding, or both'],
		[updateCampaign, { campaignId: '9', bidding: 'MANUAL_CPC', targetCpa: 3 }, 'targetCpa'],
		[updateAdGroup, { adGroupId: '5' }, 'name, cpcBid, or both'],
		[updateKeywordStatus, { adGroupId: '5', criterionIds: ['1'], status: 'REMOVED' }, 'status'],
		[
			updateKeywordStatus,
			{ adGroupId: '5', criterionIds: ['1', '1'], status: 'PAUSED' },
			'duplicate'
		]
	] as const)('%# rejects bad input before any request', async (tool, input, message) => {
		const api = fakeApi();
		await expect(api.call(tool, { customerId, ...input })).rejects.toThrow(message);
		expect(api.requests).toHaveLength(0);
	});
});

describe('negative keyword lists', () => {
	const list = {
		sharedSet: {
			resourceName: c('sharedSets/40'),
			id: '40',
			name: 'Common',
			type: 'NEGATIVE_KEYWORDS' as const,
			status: 'ENABLED' as const
		}
	};

	/** shared_set lookup, existing terms and campaign links of list 40. */
	function listApi() {
		return fakeApi({
			search: (query) => {
				if (query.includes('FROM shared_set')) return [list];
				if (query.includes('FROM shared_criterion'))
					return [
						{
							sharedCriterion: {
								resourceName: c('sharedCriteria/40~1'),
								keyword: { text: 'free', matchType: 'BROAD' }
							}
						}
					];
				if (query.includes('FROM campaign_shared_set'))
					return [
						{
							campaignSharedSet: {
								resourceName: c('campaignSharedSets/9~40'),
								campaign: c('campaigns/9')
							}
						}
					];
				return [];
			}
		});
	}

	it('creates a list with keywords and campaign links in one request', async () => {
		const api = fakeApi();
		const result = await api.call(createNegativeKeywordList, {
			customerId,
			name: 'Freebies',
			keywords: [{ text: 'free' }, { text: 'diy', matchType: 'phrase' }],
			campaignIds: ['9']
		});
		expect(api.mutates[0]!.operations).toEqual([
			{
				sharedSetOperation: {
					create: { resourceName: c('sharedSets/-1'), name: 'Freebies', type: 'NEGATIVE_KEYWORDS' }
				}
			},
			{
				sharedCriterionOperation: {
					create: { sharedSet: c('sharedSets/-1'), keyword: { text: 'free', matchType: 'EXACT' } }
				}
			},
			{
				sharedCriterionOperation: {
					create: { sharedSet: c('sharedSets/-1'), keyword: { text: 'diy', matchType: 'PHRASE' } }
				}
			},
			{
				campaignSharedSetOperation: {
					create: { campaign: c('campaigns/9'), sharedSet: c('sharedSets/-1') }
				}
			}
		]);
		expect(result.listId).toMatch(/^\d+$/);
	});

	it('adds only new keywords', async () => {
		const api = listApi();
		const result = await api.call(addKeywordsToNegativeKeywordList, {
			customerId,
			listId: '40',
			keywords: [
				{ text: 'FREE', matchType: 'BROAD' },
				{ text: 'free', matchType: 'EXACT' }
			]
		});
		expect(api.mutates[0]!.operations).toEqual([
			{
				sharedCriterionOperation: {
					create: { sharedSet: c('sharedSets/40'), keyword: { text: 'free', matchType: 'EXACT' } }
				}
			}
		]);
		expect(result.skippedExisting).toEqual([{ text: 'FREE', matchType: 'BROAD' }]);
	});

	it('removes existing keywords and removes nothing if one is missing', async () => {
		const api = listApi();
		await api.call(removeKeywordsFromNegativeKeywordList, {
			customerId,
			listId: '40',
			keywords: [{ text: 'free', matchType: 'BROAD' }]
		});
		expect(api.mutates[0]!.operations).toEqual([
			{ sharedCriterionOperation: { remove: c('sharedCriteria/40~1') } }
		]);
		await expect(
			api.call(removeKeywordsFromNegativeKeywordList, {
				customerId,
				listId: '40',
				keywords: [
					{ text: 'free', matchType: 'BROAD' },
					{ text: 'cheap', matchType: 'BROAD' }
				]
			})
		).rejects.toThrow("Not in list 40: 'cheap' (BROAD). Nothing was removed.");
		expect(api.mutates).toHaveLength(1);
	});

	it('attaches to new campaigns only and detaches only existing links', async () => {
		const api = listApi();
		const attached = await api.call(attachNegativeKeywordList, {
			customerId,
			listId: '40',
			campaignIds: ['9', '10']
		});
		expect(attached).toMatchObject({ attached: ['10'], alreadyAttached: ['9'] });
		await api.call(detachNegativeKeywordList, { customerId, listId: '40', campaignIds: ['9'] });
		expect(api.mutates.map((m) => m.operations)).toEqual([
			[
				{
					campaignSharedSetOperation: {
						create: { campaign: c('campaigns/10'), sharedSet: c('sharedSets/40') }
					}
				}
			],
			[{ campaignSharedSetOperation: { remove: c('campaignSharedSets/9~40') } }]
		]);
		await expect(
			api.call(detachNegativeKeywordList, { customerId, listId: '40', campaignIds: ['10'] })
		).rejects.toThrow('not attached to campaign 10');
		expect(api.mutates).toHaveLength(2);
	});

	it('refuses shared sets that are not negative keyword lists', async () => {
		const api = fakeApi({
			search: () => [{ sharedSet: { ...list.sharedSet, type: 'NEGATIVE_PLACEMENTS' } }]
		});
		await expect(
			api.call(attachNegativeKeywordList, { customerId, listId: '40', campaignIds: ['9'] })
		).rejects.toThrow('not a negative keyword list');
		expect(api.mutates).toHaveLength(0);
	});
});

describe('MutatePlan', () => {
	function campaignPlan() {
		const plan = new MutatePlan('123-456-7890');
		const budget = plan.tempResourceName('campaignBudgets');
		plan.add(
			campaignBudgetOperation({
				resourceName: budget,
				name: 'B',
				amountMicros: 1e6,
				explicitlyShared: false
			}),
			'budget'
		);
		const campaign = plan.tempResourceName('campaigns');
		plan.add(
			searchCampaignOperation({
				resourceName: campaign,
				name: 'C',
				budget,
				bidding: { strategy: 'MAXIMIZE_CLICKS' },
				containsEuPoliticalAdvertising: false
			}),
			'campaign'
		);
		return { plan, budget, campaign };
	}

	it('publishes atomically and maps results to keys', async () => {
		const api = fakeApi();
		const { plan } = campaignPlan();
		const dryRun = await plan.publish(api.ads, { validateOnly: true });
		expect(dryRun.resourceNames).toEqual({ budget: null, campaign: null });
		const result = await plan.publish(api.ads);
		expect(result.resourceNames.budget).toMatch(/^customers\/1234567890\/campaignBudgets\/\d+$/);
		expect(result.resourceNames.campaign).toMatch(/^customers\/1234567890\/campaigns\/\d+$/);
		expect(api.mutates.map((m) => m.validateOnly)).toEqual([true, false]);
		expect(api.mutates[1]!.operations).toHaveLength(2);
	});

	it('rejects temporary names used before they are created or not reserved', () => {
		const { plan, campaign } = campaignPlan();
		const adGroup = plan.tempResourceName('adGroups');
		expect(() => plan.add(keywordOperation({ adGroup, text: 'sofa', matchType: 'EXACT' }))).toThrow(
			'used before the operation that creates it'
		);
		expect(() =>
			plan.add(keywordOperation({ adGroup: c('adGroups/-99'), text: 'sofa', matchType: 'EXACT' }))
		).toThrow('not reserved');
		expect(() =>
			plan.add(
				keywordOperation({ adGroup: 'customers/1/adGroups/-1', text: 'sofa', matchType: 'EXACT' })
			)
		).toThrow('another customer');
		expect(() =>
			plan.add(
				campaignBudgetOperation({ name: 'x', amountMicros: 1, explicitlyShared: false }),
				'budget'
			)
		).toThrow("Duplicate plan key 'budget'");
		expect(campaign).toBe(c('campaigns/-2'));
		expect(plan.size).toBe(2);
	});

	it('refuses an atomic publish above the mutate limit without sending it', async () => {
		const api = fakeApi();
		const plan = new MutatePlan(customerId);
		for (let i = 0; i <= MAX_MUTATE_OPERATIONS; i++)
			plan.add(keywordOperation({ adGroup: c('adGroups/5'), text: `kw ${i}`, matchType: 'EXACT' }));
		await expect(plan.publish(api.ads)).rejects.toThrow('publishInBackground');
		expect(api.requests).toHaveLength(0);
	});

	it('publishes in the background through a batch job with progress and per-operation failures', async () => {
		const job = c('batchJobs/700');
		let polls = 0;
		const api = fakeApi({
			search: (query) => {
				expect(query).toContain(`batch_job.resource_name = '${job}'`);
				polls++;
				return [
					{
						batchJob: {
							resourceName: job,
							status: polls < 2 ? 'RUNNING' : 'DONE',
							metadata: {
								operationCount: '3',
								executedOperationCount: polls < 2 ? '1' : '3',
								estimatedCompletionRatio: polls < 2 ? 0.33 : 1
							}
						}
					}
				];
			},
			other: ({ path, body }) => {
				if (path.endsWith('/batchJobs:mutate')) return [200, { result: { resourceName: job } }];
				if (path.endsWith(':addOperations')) {
					const token = body?.sequenceToken as string | undefined;
					return [200, { nextSequenceToken: `${token ?? ''}t`, totalOperations: '3' }];
				}
				if (path.endsWith(':run')) return [200, { name: c('operations/1') }];
				if (path.endsWith(':listResults'))
					return [
						200,
						{
							results: [
								{
									operationIndex: '0',
									mutateOperationResponse: {
										campaignBudgetResult: { resourceName: c('campaignBudgets/1') }
									}
								},
								{
									operationIndex: '1',
									mutateOperationResponse: { campaignResult: { resourceName: c('campaigns/2') } }
								},
								{
									operationIndex: '2',
									status: {
										code: 3,
										message: 'Invalid',
										details: [
											{
												'@type':
													'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
												errors: [
													{
														errorCode: { criterionError: 'KEYWORD_HAS_INVALID_CHARS' },
														message: 'Keyword has invalid characters.'
													}
												]
											}
										]
									}
								}
							] satisfies services.BatchJobResult[]
						}
					];
				return [404, {}];
			}
		});
		const { plan, campaign } = campaignPlan();
		plan.add(
			{
				campaignCriterionOperation: {
					create: { campaign, negative: true, keyword: { text: 'bad!', matchType: 'EXACT' } }
				}
			},
			'negative'
		);
		const progress: number[] = [];
		const outcome = await plan.publishInBackground(api.ads, {
			chunkSize: 2,
			pollIntervalMs: 1,
			onProgress: (p) => progress.push(p.completionRatio)
		});
		const added = api.requests.filter((r) => r.path.endsWith(':addOperations'));
		expect(added.map((r) => (r.body?.mutateOperations as unknown[]).length)).toEqual([2, 1]);
		expect(added.map((r) => r.body?.sequenceToken)).toEqual([undefined, 't']);
		expect(api.requests.some((r) => r.path === '/customers/1234567890/batchJobs/700:run')).toBe(
			true
		);
		expect(progress).toEqual([0.33, 1]);
		expect(outcome.resourceNames).toEqual({
			budget: c('campaignBudgets/1'),
			campaign: c('campaigns/2'),
			negative: null
		});
		expect(outcome.failures).toMatchObject([
			{
				index: 2,
				key: 'negative',
				message: 'criterionError.KEYWORD_HAS_INVALID_CHARS: Keyword has invalid characters.'
			}
		]);
	});
});
