import { z } from 'zod';
import { customerId, fromMicros, num } from './schemas.ts';
import { defineTool } from './define-tool.ts';

export const listAccessibleCustomers = defineTool({
	name: 'list_accessible_customers',
	title: 'List accessible accounts',
	description:
		'Lists the Google Ads customer IDs the signed-in Google user can access directly. ' +
		'Call this first when you do not know which customerId to use for other tools. ' +
		'Client accounts reached through a manager (MCC) account are not listed here; query `customer_client` ' +
		'with the search tool on the manager account to find them.',
	input: z.object({}),
	output: z.object({
		customerIds: z.array(z.string()).describe('10-digit customer IDs, no dashes.')
	}),
	annotations: { readOnly: true, idempotent: true },
	async run(_input, { ads }) {
		const resourceNames = await ads.listAccessibleCustomers();
		return { customerIds: resourceNames.map((name) => name.replace('customers/', '')) };
	}
});

const dateRanges = [
	'TODAY',
	'YESTERDAY',
	'LAST_7_DAYS',
	'LAST_14_DAYS',
	'LAST_30_DAYS',
	'THIS_MONTH',
	'LAST_MONTH'
] as const;

export const listCampaigns = defineTool({
	name: 'list_campaigns',
	title: 'List campaigns',
	description:
		'Lists the non-removed campaigns of one account with status, channel, daily budget and performance ' +
		'(impressions, clicks, cost, conversions) over a date range, most expensive first. ' +
		'Money is in account currency units. Use it for an overview and to get campaign IDs; ' +
		'use the search tool for anything more specific.',
	input: z.object({
		customerId,
		dateRange: z.enum(dateRanges).default('LAST_30_DAYS')
	}),
	output: z.object({
		campaigns: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				status: z.string().describe('ENABLED or PAUSED.'),
				channel: z.string().describe('Advertising channel, e.g. SEARCH, PERFORMANCE_MAX.'),
				dailyBudget: z.number().nullable(),
				impressions: z.number(),
				clicks: z.number(),
				cost: z.number(),
				conversions: z.number()
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, dateRange }, { ads }) {
		const rows = await ads.search(
			customerId,
			`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
				campaign_budget.amount_micros,
				metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
			FROM campaign
			WHERE campaign.status != 'REMOVED' AND segments.date DURING ${dateRange}
			ORDER BY metrics.cost_micros DESC`
		);
		return {
			campaigns: rows.map(({ campaign, campaignBudget, metrics }) => ({
				id: String(campaign?.id),
				name: String(campaign?.name),
				status: String(campaign?.status),
				channel: String(campaign?.advertisingChannelType),
				dailyBudget: fromMicros(campaignBudget?.amountMicros),
				impressions: num(metrics?.impressions),
				clicks: num(metrics?.clicks),
				cost: num(metrics?.costMicros) / 1e6,
				conversions: num(metrics?.conversions)
			}))
		};
	}
});
