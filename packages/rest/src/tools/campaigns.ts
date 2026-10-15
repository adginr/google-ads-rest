import { z } from 'zod';
import { resourceNames } from '../resource-names.ts';
import { defineTool } from './define-tool.ts';
import { customerId, entityId, fromMicros, money, validateOnly } from './schemas.ts';

const campaignId = entityId(
	'Campaign ID, digits only. Get it from list_campaigns or the search tool.'
);

function campaignStatusTool(status: 'PAUSED' | 'ENABLED') {
	const paused = status === 'PAUSED';
	return defineTool({
		name: paused ? 'pause_campaign' : 'enable_campaign',
		title: paused ? 'Pause campaign' : 'Enable campaign',
		description: paused
			? 'Pauses a campaign (status PAUSED): it stops serving and spending immediately. Reversible with enable_campaign.'
			: 'Enables a campaign (status ENABLED): it starts serving and spending as soon as Google approves its ads. ' +
				'Reversible with pause_campaign.',
		input: z.object({ customerId, campaignId, validateOnly }),
		output: z.object({
			campaign: z.string().nullable().describe('Resource name; null for a dry run.'),
			status: z.literal(status),
			validateOnly: z.boolean()
		}),
		annotations: { readOnly: false, destructive: false, idempotent: true },
		async run({ customerId, campaignId, validateOnly }, { ads }) {
			const [result] = await ads.mutate(
				customerId,
				[
					{
						campaignOperation: {
							update: { resourceName: resourceNames.campaign(customerId, campaignId), status },
							updateMask: 'status'
						}
					}
				],
				{ validateOnly }
			);
			return {
				campaign: result?.campaignResult?.resourceName ?? null,
				status,
				validateOnly
			};
		}
	});
}

export const pauseCampaign = campaignStatusTool('PAUSED');
export const enableCampaign = campaignStatusTool('ENABLED');

export const updateCampaignBudget = defineTool({
	name: 'update_campaign_budget',
	title: 'Update campaign budget',
	description:
		"Sets the daily amount of a campaign's budget. A shared budget (used by several campaigns) changes for " +
		'all of them, so it is refused unless allowSharedBudget is true; the result lists how many campaigns use it.',
	input: z.object({
		customerId,
		campaignId,
		dailyBudget: money('New daily budget.'),
		allowSharedBudget: z
			.boolean()
			.default(false)
			.describe(
				'Set true only when the user agreed to change a budget shared by several campaigns.'
			),
		validateOnly
	}),
	output: z.object({
		budget: z.string().describe('Budget resource name.'),
		previousDailyBudget: z.number().nullable(),
		dailyBudget: z.number(),
		sharedByCampaigns: z.number().describe('How many campaigns use this budget.'),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: true },
	async run({ customerId, campaignId, dailyBudget, allowSharedBudget, validateOnly }, { ads }) {
		const [row] = await ads.search(
			customerId,
			`SELECT campaign_budget.resource_name, campaign_budget.amount_micros,
				campaign_budget.explicitly_shared, campaign_budget.reference_count
			FROM campaign WHERE campaign.id = ${campaignId}`
		);
		const budget = row?.campaignBudget;
		if (!budget?.resourceName) {
			throw new Error(`Campaign ${campaignId} not found or has no budget attached.`);
		}
		const sharedByCampaigns = Number(budget.referenceCount ?? 1);
		if ((budget.explicitlyShared || sharedByCampaigns > 1) && !allowSharedBudget) {
			throw new Error(
				`The budget of campaign ${campaignId} is shared by ${sharedByCampaigns} campaigns; changing it changes all of ` +
					'them. Confirm with the user, then retry with allowSharedBudget: true.'
			);
		}
		await ads.mutate(
			customerId,
			[
				{
					campaignBudgetOperation: {
						update: { resourceName: budget.resourceName, amountMicros: String(dailyBudget) },
						updateMask: 'amountMicros'
					}
				}
			],
			{ validateOnly }
		);
		return {
			budget: budget.resourceName,
			previousDailyBudget: fromMicros(budget.amountMicros),
			dailyBudget: dailyBudget / 1e6,
			sharedByCampaigns,
			validateOnly
		};
	}
});
