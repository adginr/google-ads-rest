import { describe, expect, it } from 'vitest';
import {
	createAdGroup,
	pauseCampaign,
	updateAdGroupStatus,
	updateCampaignBudget
} from '../src/tools/index.ts';
import { fakeApi } from './fake-api.ts';

describe('campaign tools', () => {
	it('pauses with an update mask of status only', async () => {
		const api = fakeApi();
		const result = await api.call(pauseCampaign, { customerId: '1234567890', campaignId: '9' });
		expect(api.mutates[0]!.operations[0]).toEqual({
			campaignOperation: {
				update: { resourceName: 'customers/1234567890/campaigns/9', status: 'PAUSED' },
				updateMask: 'status'
			}
		});
		expect(result.campaign).toBe('customers/1234567890/campaigns/9');
	});

	it('updates a budget in micros and reports the previous amount', async () => {
		const api = fakeApi({
			search: () => [
				{
					campaignBudget: {
						resourceName: 'customers/1234567890/campaignBudgets/4',
						amountMicros: '50000000',
						referenceCount: '1'
					}
				}
			]
		});
		const result = await api.call(updateCampaignBudget, {
			customerId: '1234567890',
			campaignId: '9',
			dailyBudget: 75.5
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			campaignBudgetOperation: {
				update: {
					resourceName: 'customers/1234567890/campaignBudgets/4',
					amountMicros: '75500000'
				},
				updateMask: 'amountMicros'
			}
		});
		expect(result).toMatchObject({ previousDailyBudget: 50, dailyBudget: 75.5 });
	});

	it('refuses a shared budget unless allowed', async () => {
		const shared = () => [
			{ campaignBudget: { resourceName: 'b', explicitlyShared: true, referenceCount: '3' } }
		];
		const api = fakeApi({ search: shared });
		const input = { customerId: '1234567890', campaignId: '9', dailyBudget: 10 };
		await expect(api.call(updateCampaignBudget, input)).rejects.toThrow('shared by 3 campaigns');
		expect(api.mutates).toHaveLength(0);
		await api.call(updateCampaignBudget, { ...input, allowSharedBudget: true });
		expect(api.mutates).toHaveLength(1);
	});
});

describe('ad group tools', () => {
	it('creates PAUSED by default and only sets a bid when given', async () => {
		const api = fakeApi();
		const result = await api.call(createAdGroup, {
			customerId: '1234567890',
			campaignId: '9',
			name: ' Leasing '
		});
		expect(api.mutates[0]!.operations[0]!.adGroupOperation!.create).toEqual({
			name: 'Leasing',
			campaign: 'customers/1234567890/campaigns/9',
			status: 'PAUSED',
			type: 'SEARCH_STANDARD'
		});
		expect(result.adGroupId).toMatch(/^\d+$/);
	});

	it('cannot create a REMOVED ad group', async () => {
		const api = fakeApi();
		await expect(
			api.call(createAdGroup, {
				customerId: '1234567890',
				campaignId: '9',
				name: 'x',
				status: 'REMOVED'
			})
		).rejects.toThrow();
	});

	it('removes with a remove operation, not a REMOVED status update', async () => {
		const api = fakeApi();
		await api.call(updateAdGroupStatus, {
			customerId: '1234567890',
			adGroupId: '5',
			status: 'removed'
		});
		expect(api.mutates[0]!.operations[0]).toEqual({
			adGroupOperation: { remove: 'customers/1234567890/adGroups/5' }
		});
	});
});
