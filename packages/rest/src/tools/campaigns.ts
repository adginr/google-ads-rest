import { z } from 'zod';
import { MutatePlan } from '../mutate-plan.ts';
import {
	biddingFields,
	campaignBudgetOperation,
	campaignTargetingOperations,
	type SearchBidding,
	searchCampaignOperation
} from '../operations.ts';
import { idFromResourceName, resourceNames } from '../resource-names.ts';
import type { resources } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import {
	customerId,
	entityId,
	fromMicros,
	isoDate,
	money,
	text,
	unique,
	upperEnum,
	validateOnly
} from './schemas.ts';

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

const biddingInputs = {
	bidding: upperEnum(['MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MANUAL_CPC'] as const).describe(
		'MAXIMIZE_CLICKS: most clicks for the budget, a safe start without conversion data. ' +
			'MAXIMIZE_CONVERSIONS: needs conversion tracking that records conversions. MANUAL_CPC: you set ' +
			'max CPC bids on ad groups or keywords.'
	),
	maxCpcBidCeiling: money('Optional max CPC limit for MAXIMIZE_CLICKS.').optional(),
	targetCpa: money('Optional target cost per conversion for MAXIMIZE_CONVERSIONS.').optional()
};

type BiddingInput = {
	bidding?: 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'MANUAL_CPC';
	maxCpcBidCeiling?: number;
	targetCpa?: number;
};

function checkBiddingOptions(input: BiddingInput, ctx: z.RefinementCtx) {
	if (input.maxCpcBidCeiling !== undefined && input.bidding !== 'MAXIMIZE_CLICKS')
		ctx.addIssue({
			code: 'custom',
			path: ['maxCpcBidCeiling'],
			message: 'maxCpcBidCeiling applies only to bidding MAXIMIZE_CLICKS.'
		});
	if (input.targetCpa !== undefined && input.bidding !== 'MAXIMIZE_CONVERSIONS')
		ctx.addIssue({
			code: 'custom',
			path: ['targetCpa'],
			message: 'targetCpa applies only to bidding MAXIMIZE_CONVERSIONS.'
		});
}

function toBidding({ bidding, maxCpcBidCeiling, targetCpa }: BiddingInput): SearchBidding {
	if (bidding === 'MAXIMIZE_CLICKS')
		return { strategy: bidding, maxCpcBidCeilingMicros: maxCpcBidCeiling };
	if (bidding === 'MAXIMIZE_CONVERSIONS') return { strategy: bidding, targetCpaMicros: targetCpa };
	return { strategy: 'MANUAL_CPC' };
}

const geoIds = (description: string) =>
	z
		.array(z.number().int().positive())
		.max(1000)
		.superRefine((ids, ctx) => unique('ID')(ids.map(String), ctx))
		.optional()
		.describe(description);

export const createCampaignBudget = defineTool({
	name: 'create_campaign_budget',
	title: 'Create campaign budget',
	description:
		'Creates a daily campaign budget on its own, e.g. a shared budget several campaigns will draw from. ' +
		'create_search_campaign can create a campaign with its own budget in one step, so this is only needed ' +
		'for shared budgets or to reuse one budget ID. A non-shared budget can belong to one campaign only. ' +
		'Budget names must be unique in the account. Nothing spends until a campaign using it is enabled.',
	input: z.object({
		customerId,
		name: text(255, 'Budget name, unique among the account budgets.'),
		dailyBudget: money('Average daily amount.'),
		explicitlyShared: z
			.boolean()
			.describe(
				'true: a shared budget several campaigns can use. false: for exactly one campaign. No default on ' +
					'purpose: a shared budget splits spend across campaigns.'
			),
		validateOnly
	}),
	output: z.object({
		budget: z.string().nullable().describe('Resource name; null for a dry run.'),
		budgetId: z.string().nullable(),
		name: z.string(),
		dailyBudget: z.number(),
		explicitlyShared: z.boolean(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, name, dailyBudget, explicitlyShared, validateOnly }, { ads }) {
		const [result] = await ads.mutate(
			customerId,
			[campaignBudgetOperation({ name, amountMicros: dailyBudget, explicitlyShared })],
			{ validateOnly }
		);
		const budget = result?.campaignBudgetResult?.resourceName ?? null;
		return {
			budget,
			budgetId: idFromResourceName(budget ?? undefined, 'campaignBudgets') ?? null,
			name,
			dailyBudget: dailyBudget / 1e6,
			explicitlyShared,
			validateOnly
		};
	}
});

export const createSearchCampaign = defineTool({
	name: 'create_search_campaign',
	title: 'Create Search campaign',
	description:
		'Creates a Search campaign with its budget, bidding, networks, dates and location and language ' +
		'targeting in one atomic request (all or nothing), PAUSED by default. It serves on Google Search ' +
		'only unless search partners or the Display Network are switched on. Give either dailyBudget (a new ' +
		'budget for this campaign) or budgetId (an existing one, e.g. shared). Then add ad groups ' +
		'(create_ad_group), keywords and ads, and enable it with enable_campaign once the user approves. ' +
		'Omitting locationIds targets every country; omitting languageIds targets all languages; the result ' +
		'warns about both. Find location IDs with suggest_geo_targets and language IDs with the search tool ' +
		'on language_constant. Run with validateOnly first to check everything without creating anything.',
	input: z
		.object({
			customerId,
			name: text(255, 'Campaign name, unique in the account.'),
			dailyBudget: money('Daily budget for a new budget owned by this campaign.').optional(),
			budgetId: entityId('Existing campaign budget ID to use instead of dailyBudget.').optional(),
			...biddingInputs,
			containsEuPoliticalAdvertising: z
				.boolean()
				.describe(
					"The advertiser's declaration, required by Google: true if the campaign has political " +
						'advertising aimed at the European Union. Ask the user; there is no default.'
				),
			includeSearchPartners: z
				.boolean()
				.default(false)
				.describe('Also serve on Google search partner sites. Default false.'),
			includeDisplayNetwork: z
				.boolean()
				.default(false)
				.describe('Also show ads on the Display Network. Default false; rarely wanted for Search.'),
			status: upperEnum(['ENABLED', 'PAUSED'] as const)
				.default('PAUSED')
				.describe('PAUSED by default; enable once it has ad groups, keywords and ads.'),
			startDate: isoDate
				.optional()
				.describe('First day, YYYY-MM-DD in the account time zone. Default: today.'),
			endDate: isoDate
				.optional()
				.describe('Last day (inclusive), YYYY-MM-DD. Default: runs until paused.'),
			locationIds: geoIds('Geo target constant IDs to target, e.g. 2784 (UAE). Up to 1000.'),
			excludedLocationIds: geoIds('Geo target constant IDs to exclude.'),
			locationTargeting: upperEnum(['PRESENCE', 'PRESENCE_OR_INTEREST'] as const)
				.default('PRESENCE')
				.describe(
					'PRESENCE (default): people in or regularly in the locations. PRESENCE_OR_INTEREST: also ' +
						'people elsewhere who search about them.'
				),
			languageIds: z
				.array(z.number().int().positive())
				.max(100)
				.superRefine((ids, ctx) => unique('language ID')(ids.map(String), ctx))
				.optional()
				.describe('Language constant IDs, e.g. 1000 English, 1019 Arabic.'),
			validateOnly
		})
		.superRefine((input, ctx) => {
			if ((input.dailyBudget === undefined) === (input.budgetId === undefined))
				ctx.addIssue({
					code: 'custom',
					path: ['dailyBudget'],
					message: 'Give exactly one of dailyBudget (new budget) or budgetId (existing budget).'
				});
			if (input.startDate && input.endDate && input.startDate > input.endDate)
				ctx.addIssue({
					code: 'custom',
					path: ['endDate'],
					message: 'startDate must be on or before endDate.'
				});
			const excluded = new Set(input.excludedLocationIds);
			const both = input.locationIds?.find((id) => excluded.has(id));
			if (both !== undefined)
				ctx.addIssue({
					code: 'custom',
					path: ['excludedLocationIds'],
					message: `location ${both} is both targeted and excluded.`
				});
			checkBiddingOptions(input, ctx);
		}),
	output: z.object({
		campaign: z.string().nullable().describe('Resource name; null for a dry run.'),
		campaignId: z.string().nullable(),
		budget: z.string().nullable().describe('Resource name; null for a dry run of a new budget.'),
		budgetId: z.string().nullable(),
		name: z.string(),
		status: z.string(),
		bidding: z.string(),
		targeting: z.object({
			locations: z.number(),
			excludedLocations: z.number(),
			languages: z.number()
		}),
		warnings: z.array(z.string()),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run(input, { ads }) {
		const { customerId, validateOnly } = input;
		const plan = new MutatePlan(customerId);
		let budget: string;
		if (input.budgetId) {
			budget = resourceNames.campaignBudget(customerId, input.budgetId);
		} else {
			budget = plan.tempResourceName('campaignBudgets');
			plan.add(
				campaignBudgetOperation({
					resourceName: budget,
					name: `${input.name} budget`,
					amountMicros: input.dailyBudget!,
					explicitlyShared: false
				}),
				'budget'
			);
		}
		const campaign = plan.tempResourceName('campaigns');
		plan.add(
			searchCampaignOperation({
				resourceName: campaign,
				name: input.name,
				budget,
				bidding: toBidding(input),
				containsEuPoliticalAdvertising: input.containsEuPoliticalAdvertising,
				status: input.status,
				includeSearchPartners: input.includeSearchPartners,
				includeDisplayNetwork: input.includeDisplayNetwork,
				startDate: input.startDate,
				endDate: input.endDate,
				locationTargeting: input.locationTargeting
			}),
			'campaign'
		);
		for (const operation of campaignTargetingOperations(campaign, input)) plan.add(operation);

		const { resourceNames: created } = await plan.publish(ads, { validateOnly });
		const budgetName = input.budgetId ? budget : (created.budget ?? null);
		const warnings: string[] = [];
		if (!input.locationIds?.length)
			warnings.push('No locationIds: the campaign targets every country and territory.');
		if (!input.languageIds?.length)
			warnings.push('No languageIds: the campaign targets all languages.');
		if (input.bidding === 'MANUAL_CPC')
			warnings.push('MANUAL_CPC needs a cpcBid on each ad group (create_ad_group) or keyword.');
		return {
			campaign: created.campaign ?? null,
			campaignId: idFromResourceName(created.campaign ?? undefined, 'campaigns') ?? null,
			budget: budgetName,
			budgetId:
				input.budgetId ?? idFromResourceName(budgetName ?? undefined, 'campaignBudgets') ?? null,
			name: input.name,
			status: input.status,
			bidding: input.bidding,
			targeting: {
				locations: input.locationIds?.length ?? 0,
				excludedLocations: input.excludedLocationIds?.length ?? 0,
				languages: input.languageIds?.length ?? 0
			},
			warnings,
			validateOnly
		};
	}
});

export const updateCampaign = defineTool({
	name: 'update_campaign',
	title: 'Update campaign',
	description:
		'Renames a campaign and/or switches its bidding strategy. Only the given fields change. Switching ' +
		'bidding resets automated learning, so performance can dip for a while. For status use ' +
		'pause_campaign / enable_campaign; for the budget use update_campaign_budget.',
	input: z
		.object({
			customerId,
			campaignId,
			name: text(255, 'New campaign name, unique in the account.').optional(),
			bidding: biddingInputs.bidding.optional(),
			maxCpcBidCeiling: biddingInputs.maxCpcBidCeiling,
			targetCpa: biddingInputs.targetCpa,
			validateOnly
		})
		.superRefine((input, ctx) => {
			if (input.name === undefined && input.bidding === undefined)
				ctx.addIssue({ code: 'custom', message: 'Give name, bidding, or both.' });
			checkBiddingOptions(input, ctx);
		}),
	output: z.object({
		campaign: z.string().nullable().describe('Resource name; null for a dry run.'),
		campaignId: z.string(),
		updated: z.array(z.string()).describe('Fields changed.'),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: true },
	async run(input, { ads }) {
		const { customerId, campaignId, validateOnly } = input;
		const update: Partial<resources.Campaign> = {
			resourceName: resourceNames.campaign(customerId, campaignId)
		};
		const mask: string[] = [];
		if (input.name !== undefined) {
			update.name = input.name;
			mask.push('name');
		}
		if (input.bidding !== undefined) {
			const { fields, updateMask } = biddingFields(toBidding(input));
			Object.assign(update, fields);
			mask.push(updateMask);
		}
		const [result] = await ads.mutate(
			customerId,
			[{ campaignOperation: { update, updateMask: mask.join(',') } }],
			{ validateOnly }
		);
		return {
			campaign: result?.campaignResult?.resourceName ?? null,
			campaignId,
			updated: [
				...(input.name !== undefined ? ['name'] : []),
				...(input.bidding !== undefined ? ['bidding'] : [])
			],
			validateOnly
		};
	}
});
