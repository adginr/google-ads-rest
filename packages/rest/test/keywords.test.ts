import { describe, expect, it } from 'vitest';
import {
	addKeywordsToAdGroup,
	addNegativeKeywordToCampaign,
	removeKeywordFromAdGroup,
	removeNegativeKeywordFromCampaign
} from '../src/tools/index.ts';
import { fakeApi } from './fake-api.ts';

const base = { customerId: '123-456-7890', adGroupId: '555' };

describe('add_keywords_to_ad_group', () => {
	it('creates positive keywords with bids in micros and never sets negative', async () => {
		const api = fakeApi();
		const result = await api.call(addKeywordsToAdGroup, {
			...base,
			keywords: [' car lease dubai ', 'lease a car'],
			matchType: 'phrase',
			cpcBid: 2.5
		});
		const [{ operations }] = api.mutates as [(typeof api.mutates)[number]];
		expect(operations).toHaveLength(2);
		expect(operations[0]!.adGroupCriterionOperation!.create).toEqual({
			adGroup: 'customers/1234567890/adGroups/555',
			status: 'ENABLED',
			keyword: { text: 'car lease dubai', matchType: 'PHRASE' },
			cpcBidMicros: '2500000'
		});
		expect(result.keywords.map((k) => k.result)).toEqual(['ADDED', 'ADDED']);
		expect(result.keywords[0]!.criterionId).toMatch(/^\d+$/);
	});

	it.each([
		[{ keywords: ['[exact]'] }, 'display syntax'],
		[{ keywords: ['"phrase"'] }, 'display syntax'],
		[{ keywords: ['-neg'] }, 'display syntax'],
		[{ keywords: ['x'.repeat(81)] }, '81 characters'],
		[{ keywords: ['a b c d e f g h i j k'] }, 'more than 10 words'],
		[{ keywords: ['Car', 'car'] }, 'duplicate keyword'],
		[{ keywords: [] }, ''],
		[{ keywords: ['ok'], matchType: undefined }, ''],
		[{ keywords: ['ok'], validateOnly: 'false' }, ''],
		[{ keywords: ['ok'], skipExisting: 'true' }, ''],
		[{ keywords: ['ok'], status: 'REMOVED' }, '']
	])('rejects %j before any request', async (override, message) => {
		const api = fakeApi();
		await expect(
			api.call(addKeywordsToAdGroup, { ...base, matchType: 'EXACT', ...override })
		).rejects.toThrow(message);
		expect(api.requests).toHaveLength(0);
	});

	it('skips existing keywords case-insensitively per match type', async () => {
		const api = fakeApi({
			search: () => [
				{ adGroupCriterion: { keyword: { text: 'Car Lease', matchType: 'EXACT' } } },
				{ adGroupCriterion: { keyword: { text: 'lease a car', matchType: 'PHRASE' } } }
			]
		});
		const result = await api.call(addKeywordsToAdGroup, {
			...base,
			keywords: ['car lease', 'lease a car'],
			matchType: 'EXACT',
			skipExisting: true
		});
		expect(api.queries[0]).toContain('ad_group_criterion.negative = FALSE');
		expect(result.keywords.map((k) => k.result)).toEqual(['SKIPPED_EXISTING', 'ADDED']);
		expect(api.mutates[0]!.operations).toHaveLength(1);
	});

	it('sends no mutate when every keyword exists', async () => {
		const api = fakeApi({
			search: () => [{ adGroupCriterion: { keyword: { text: 'car', matchType: 'EXACT' } } }]
		});
		const result = await api.call(addKeywordsToAdGroup, {
			...base,
			keywords: ['car'],
			matchType: 'EXACT',
			skipExisting: true,
			validateOnly: true
		});
		expect(api.mutates).toHaveLength(0);
		expect(result.keywords[0]!.result).toBe('SKIPPED_EXISTING');
	});

	it('marks dry-run keywords as VALIDATED', async () => {
		const api = fakeApi();
		const result = await api.call(addKeywordsToAdGroup, {
			...base,
			keywords: ['car'],
			matchType: 'BROAD',
			validateOnly: true
		});
		expect(result.keywords[0]).toMatchObject({ result: 'VALIDATED', resourceName: null });
		expect(api.mutates[0]!.validateOnly).toBe(true);
	});
});

describe('remove_keyword_from_ad_group', () => {
	it('looks up a positive keyword by text with escaping, then removes it', async () => {
		const api = fakeApi({
			search: () => [
				{
					adGroupCriterion: {
						resourceName: 'customers/1234567890/adGroupCriteria/555~777',
						criterionId: '777',
						keyword: { text: "o'brien leasing", matchType: 'EXACT' }
					}
				}
			]
		});
		const result = await api.call(removeKeywordFromAdGroup, {
			...base,
			keyword: "o'brien leasing",
			matchType: 'exact'
		});
		expect(api.queries[0]).toContain("ad_group_criterion.keyword.text = 'o\\'brien leasing'");
		expect(api.queries[0]).toContain('ad_group_criterion.negative = FALSE');
		expect(api.mutates[0]!.operations[0]).toEqual({
			adGroupCriterionOperation: { remove: 'customers/1234567890/adGroupCriteria/555~777' }
		});
		expect(result).toMatchObject({
			criterionId: '777',
			keyword: "o'brien leasing",
			matchType: 'EXACT'
		});
	});

	it('refuses to remove when nothing positive matches', async () => {
		const api = fakeApi({ search: () => [] });
		await expect(
			api.call(removeKeywordFromAdGroup, { ...base, criterionId: '777' })
		).rejects.toThrow('No positive keyword matching criterion 777');
		expect(api.mutates).toHaveLength(0);
	});

	it.each([
		[{ criterionId: '1', keyword: 'x', matchType: 'EXACT' }, 'not both'],
		[{}, 'Supply either'],
		[{ keyword: 'x' }, 'matchType is required']
	])('validates the selector %j', async (selector, message) => {
		const api = fakeApi();
		await expect(api.call(removeKeywordFromAdGroup, { ...base, ...selector })).rejects.toThrow(
			message
		);
		expect(api.requests).toHaveLength(0);
	});
});

describe('campaign negative keywords', () => {
	it('adds a negative criterion with EXACT by default', async () => {
		const api = fakeApi();
		await api.call(addNegativeKeywordToCampaign, {
			customerId: '1234567890',
			campaignId: '9',
			keyword: 'free'
		});
		expect(api.mutates[0]!.operations[0]!.campaignCriterionOperation!.create).toEqual({
			campaign: 'customers/1234567890/campaigns/9',
			negative: true,
			keyword: { text: 'free', matchType: 'EXACT' }
		});
	});

	it('removes only a matching negative', async () => {
		const api = fakeApi({
			search: () => [
				{ campaignCriterion: { resourceName: 'customers/1234567890/campaignCriteria/9~3' } }
			]
		});
		await api.call(removeNegativeKeywordFromCampaign, {
			customerId: '1234567890',
			campaignId: '9',
			keyword: 'free',
			matchType: 'PHRASE'
		});
		expect(api.queries[0]).toContain('campaign_criterion.negative = TRUE');
		expect(api.queries[0]).toContain("campaign_criterion.keyword.match_type = 'PHRASE'");
		expect(api.mutates[0]!.operations[0]).toEqual({
			campaignCriterionOperation: { remove: 'customers/1234567890/campaignCriteria/9~3' }
		});
	});
});
