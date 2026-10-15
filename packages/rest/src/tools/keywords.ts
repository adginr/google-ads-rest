import { z } from 'zod';
import { gaqlString } from '../gaql.ts';
import { idFromResourceName, resourceNames } from '../resource-names.ts';
import type { services } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import {
	charCount,
	customerId,
	entityId,
	matchType,
	money,
	uniqueIgnoringCase,
	upperEnum,
	validateOnly
} from './schemas.ts';

const MAX_KEYWORD_CHARS = 80;
const MAX_KEYWORD_WORDS = 10;
const MAX_KEYWORDS_PER_REQUEST = 500;

/** Bare keyword text. Display syntax ([exact], "phrase", +modifier, -negative) would be stored literally. */
const keywordText = z
	.string()
	.trim()
	.min(1, 'keyword cannot be empty.')
	.superRefine((value, ctx) => {
		if (/^[["+-]/.test(value)) {
			ctx.addIssue({
				code: 'custom',
				message: `keyword '${value}' uses match-type display syntax; pass bare text and set matchType instead.`
			});
		}
		if (charCount(value) > MAX_KEYWORD_CHARS) {
			ctx.addIssue({
				code: 'custom',
				message: `keyword '${value}' is ${charCount(value)} characters; the maximum is ${MAX_KEYWORD_CHARS}.`
			});
		}
		if (value.split(/\s+/).length > MAX_KEYWORD_WORDS) {
			ctx.addIssue({
				code: 'custom',
				message: `keyword '${value}' has more than ${MAX_KEYWORD_WORDS} words.`
			});
		}
	});

const adGroupId = entityId('Ad group ID, digits only. Get it with the search tool on ad_group.');
const campaignId = entityId(
	'Campaign ID, digits only. Get it from list_campaigns or the search tool.'
);

const POSITIVE_KEYWORDS_OF = (customerId: string, adGroupId: string) =>
	[
		`ad_group_criterion.ad_group = ${gaqlString(resourceNames.adGroup(customerId, adGroupId))}`,
		"ad_group_criterion.type = 'KEYWORD'",
		'ad_group_criterion.negative = FALSE',
		"ad_group_criterion.status != 'REMOVED'"
	].join(' AND ');

export const addKeywordsToAdGroup = defineTool({
	name: 'add_keywords_to_ad_group',
	title: 'Add keywords to ad group',
	description:
		'Adds positive keywords to an ad group, all with the same match type (call once per match type). ' +
		'The request is atomic: one invalid or duplicate keyword fails all of them, so use skipExisting for ' +
		'top-up runs. Pass bare text: "car lease dubai", not [car lease dubai] or "car lease dubai" in quotes.',
	input: z.object({
		customerId,
		adGroupId,
		keywords: z
			.array(keywordText)
			.min(1)
			.max(MAX_KEYWORDS_PER_REQUEST)
			.superRefine(uniqueIgnoringCase('keyword in request'))
			.describe(
				`Bare keyword texts; each at most ${MAX_KEYWORD_CHARS} characters and ${MAX_KEYWORD_WORDS} words, ` +
					`at most ${MAX_KEYWORDS_PER_REQUEST} per call.`
			),
		matchType: matchType.describe(
			'Match type for every keyword in this call. No default on purpose: it changes what the ad group buys.'
		),
		status: upperEnum(['ENABLED', 'PAUSED'] as const).default('ENABLED'),
		cpcBid: money('Optional max CPC bid per keyword; omit to inherit the ad group bid.').optional(),
		skipExisting: z
			.boolean()
			.default(false)
			.describe(
				'Skip keywords already in the ad group with the same text (any case) and match type instead of failing.'
			),
		validateOnly
	}),
	output: z.object({
		adGroupId: z.string(),
		matchType: z.string(),
		status: z.string(),
		keywords: z.array(
			z.object({
				keyword: z.string(),
				result: z.enum(['ADDED', 'SKIPPED_EXISTING', 'VALIDATED']),
				criterionId: z.string().nullable(),
				resourceName: z.string().nullable()
			})
		),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run(input, { ads }) {
		const { customerId, adGroupId, keywords, matchType, status, cpcBid, validateOnly } = input;

		const existing = new Set<string>();
		if (input.skipExisting) {
			const rows = await ads.search(
				customerId,
				`SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
				FROM ad_group_criterion WHERE ${POSITIVE_KEYWORDS_OF(customerId, adGroupId)}`
			);
			for (const { adGroupCriterion } of rows) {
				const kw = adGroupCriterion?.keyword;
				if (kw?.text && kw.matchType) existing.add(`${kw.text.toLowerCase()}|${kw.matchType}`);
			}
		}

		const pending = keywords.filter((text) => !existing.has(`${text.toLowerCase()}|${matchType}`));
		const operations: services.MutateOperation[] = pending.map((text) => ({
			adGroupCriterionOperation: {
				create: {
					adGroup: resourceNames.adGroup(customerId, adGroupId),
					status,
					keyword: { text, matchType },
					...(cpcBid === undefined ? {} : { cpcBidMicros: String(cpcBid) })
				}
			}
		}));
		// An empty mutate is an API error; nothing to send when every keyword already exists.
		const results = operations.length
			? await ads.mutate(customerId, operations, { validateOnly })
			: [];

		const created = new Map(
			pending.map((text, i) => [text, results[i]?.adGroupCriterionResult?.resourceName ?? null])
		);
		return {
			adGroupId,
			matchType,
			status,
			keywords: keywords.map((keyword) => {
				if (!created.has(keyword)) {
					return {
						keyword,
						result: 'SKIPPED_EXISTING' as const,
						criterionId: null,
						resourceName: null
					};
				}
				const resourceName = created.get(keyword) ?? null;
				return {
					keyword,
					result: validateOnly ? ('VALIDATED' as const) : ('ADDED' as const),
					criterionId: idFromResourceName(resourceName ?? undefined, 'adGroupCriteria') ?? null,
					resourceName
				};
			}),
			validateOnly
		};
	}
});

export const removeKeywordFromAdGroup = defineTool({
	name: 'remove_keyword_from_ad_group',
	title: 'Remove keyword from ad group',
	description:
		'Removes one positive keyword from an ad group, selected by criterionId or by exact text plus match type. ' +
		'It is looked up first and must be a positive, non-removed keyword of that ad group (negatives are never ' +
		'touched). Removal is permanent: the keyword can only be re-added as a new criterion without its history.',
	input: z
		.object({
			customerId,
			adGroupId,
			criterionId: entityId(
				'Criterion ID: the part after "~" in customers/1/adGroupCriteria/111~222. Use either this or keyword.'
			).optional(),
			keyword: keywordText.optional().describe('Exact bare keyword text. Requires matchType.'),
			matchType: matchType
				.optional()
				.describe(
					'Required with keyword. No default: the same text often exists in several match types.'
				),
			validateOnly
		})
		.superRefine((input, ctx) => {
			if (input.criterionId && input.keyword)
				ctx.addIssue({
					code: 'custom',
					message: 'Supply either criterionId or keyword, not both.'
				});
			if (!input.criterionId && !input.keyword)
				ctx.addIssue({ code: 'custom', message: 'Supply either criterionId or keyword.' });
			if (input.keyword && !input.matchType)
				ctx.addIssue({
					code: 'custom',
					message: 'matchType is required when removing a keyword by text: EXACT, PHRASE or BROAD.'
				});
		}),
	output: z.object({
		removed: z
			.string()
			.nullable()
			.describe('Resource name of the removed criterion; null for a dry run.'),
		adGroupId: z.string(),
		criterionId: z.string(),
		keyword: z.string().nullable(),
		matchType: z.string().nullable(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: false },
	async run({ customerId, adGroupId, criterionId, keyword, matchType, validateOnly }, { ads }) {
		const selector = criterionId
			? `ad_group_criterion.criterion_id = ${criterionId}`
			: `ad_group_criterion.keyword.match_type = '${matchType}' AND ad_group_criterion.keyword.text = ${gaqlString(keyword!)}`;
		const [row] = await ads.search(
			customerId,
			`SELECT ad_group_criterion.resource_name, ad_group_criterion.criterion_id,
				ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
			FROM ad_group_criterion
			WHERE ${POSITIVE_KEYWORDS_OF(customerId, adGroupId)} AND ${selector}
			LIMIT 1`
		);
		const found = row?.adGroupCriterion;
		if (!found?.resourceName) {
			const what = criterionId ? `criterion ${criterionId}` : `keyword '${keyword}' (${matchType})`;
			throw new Error(`No positive keyword matching ${what} found on ad group ${adGroupId}.`);
		}

		const [result] = await ads.mutate(
			customerId,
			[{ adGroupCriterionOperation: { remove: found.resourceName } }],
			{ validateOnly }
		);
		return {
			removed: result?.adGroupCriterionResult?.resourceName ?? null,
			adGroupId,
			criterionId:
				found.criterionId ??
				idFromResourceName(found.resourceName, 'adGroupCriteria') ??
				criterionId!,
			keyword: found.keyword?.text ?? keyword ?? null,
			matchType: found.keyword?.matchType ?? matchType ?? null,
			validateOnly
		};
	}
});

export const addNegativeKeywordToAdGroup = defineTool({
	name: 'add_negative_keyword_to_ad_group',
	title: 'Add negative keyword to ad group',
	description:
		'Adds a negative keyword to one ad group so its ads stop showing for matching searches. ' +
		'Pass bare text (no brackets, quotes or leading minus). For a whole campaign use add_negative_keyword_to_campaign.',
	input: z.object({
		customerId,
		adGroupId,
		keyword: keywordText.describe('Bare negative keyword text.'),
		matchType: matchType.default('EXACT'),
		validateOnly
	}),
	output: z.object({
		criterion: z.string().nullable().describe('Resource name; null for a dry run.'),
		adGroupId: z.string(),
		keyword: z.string(),
		matchType: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, adGroupId, keyword, matchType, validateOnly }, { ads }) {
		const [result] = await ads.mutate(
			customerId,
			[
				{
					adGroupCriterionOperation: {
						create: {
							adGroup: resourceNames.adGroup(customerId, adGroupId),
							negative: true,
							keyword: { text: keyword, matchType }
						}
					}
				}
			],
			{ validateOnly }
		);
		return {
			criterion: result?.adGroupCriterionResult?.resourceName ?? null,
			adGroupId,
			keyword,
			matchType,
			validateOnly
		};
	}
});

export const addNegativeKeywordToCampaign = defineTool({
	name: 'add_negative_keyword_to_campaign',
	title: 'Add negative keyword to campaign',
	description:
		'Adds a negative keyword to a campaign so none of its ads show for matching searches. ' +
		'Pass bare text (no brackets, quotes or leading minus).',
	input: z.object({
		customerId,
		campaignId,
		keyword: keywordText.describe('Bare negative keyword text.'),
		matchType: matchType.default('EXACT'),
		validateOnly
	}),
	output: z.object({
		criterion: z.string().nullable().describe('Resource name; null for a dry run.'),
		campaignId: z.string(),
		keyword: z.string(),
		matchType: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, campaignId, keyword, matchType, validateOnly }, { ads }) {
		const [result] = await ads.mutate(
			customerId,
			[
				{
					campaignCriterionOperation: {
						create: {
							campaign: resourceNames.campaign(customerId, campaignId),
							negative: true,
							keyword: { text: keyword, matchType }
						}
					}
				}
			],
			{ validateOnly }
		);
		return {
			criterion: result?.campaignCriterionResult?.resourceName ?? null,
			campaignId,
			keyword,
			matchType,
			validateOnly
		};
	}
});

export const removeNegativeKeywordFromCampaign = defineTool({
	name: 'remove_negative_keyword_from_campaign',
	title: 'Remove negative keyword from campaign',
	description:
		'Removes a campaign-level negative keyword matched by exact text and match type, so the campaign can ' +
		'show for those searches again.',
	input: z.object({
		customerId,
		campaignId,
		keyword: keywordText.describe('Exact bare negative keyword text.'),
		matchType: matchType.default('EXACT'),
		validateOnly
	}),
	output: z.object({
		removed: z.string().nullable().describe('Resource name; null for a dry run.'),
		campaignId: z.string(),
		keyword: z.string(),
		matchType: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: false },
	async run({ customerId, campaignId, keyword, matchType, validateOnly }, { ads }) {
		const [row] = await ads.search(
			customerId,
			`SELECT campaign_criterion.resource_name FROM campaign_criterion
			WHERE campaign_criterion.campaign = ${gaqlString(resourceNames.campaign(customerId, campaignId))}
				AND campaign_criterion.type = 'KEYWORD'
				AND campaign_criterion.negative = TRUE
				AND campaign_criterion.keyword.match_type = '${matchType}'
				AND campaign_criterion.keyword.text = ${gaqlString(keyword)}
			LIMIT 1`
		);
		const resourceName = row?.campaignCriterion?.resourceName;
		if (!resourceName) {
			throw new Error(
				`No negative keyword '${keyword}' (${matchType}) found on campaign ${campaignId}.`
			);
		}
		const [result] = await ads.mutate(
			customerId,
			[{ campaignCriterionOperation: { remove: resourceName } }],
			{ validateOnly }
		);
		return {
			removed: result?.campaignCriterionResult?.resourceName ?? null,
			campaignId,
			keyword,
			matchType,
			validateOnly
		};
	}
});
