import { z } from 'zod';
import type { GoogleAdsClient } from '../client.ts';
import { gaqlString } from '../gaql.ts';
import { MutatePlan } from '../mutate-plan.ts';
import {
	campaignSharedSetOperation,
	negativeKeywordListOperation,
	sharedNegativeKeywordOperation
} from '../operations.ts';
import { idFromResourceName, resourceNames } from '../resource-names.ts';
import { defineTool } from './define-tool.ts';
import { keywordText } from './keywords.ts';
import { customerId, entityId, matchType, num, text, unique, validateOnly } from './schemas.ts';

const MAX_TERMS_PER_REQUEST = 1000;

const listId = entityId(
	'Negative keyword list (shared set) ID. Get it from list_negative_keyword_lists.'
);

const terms = z
	.array(
		z.object({
			text: keywordText.describe('Bare negative keyword text.'),
			matchType: matchType.default('EXACT')
		})
	)
	.max(MAX_TERMS_PER_REQUEST)
	.superRefine((items, ctx) =>
		unique('keyword and match type')(
			items.map((item) => `${item.text.toLowerCase()}|${item.matchType}`),
			ctx
		)
	)
	.describe(
		`Negative keywords, e.g. [{ "text": "free", "matchType": "BROAD" }]. Match type defaults to EXACT. ` +
			`At most ${MAX_TERMS_PER_REQUEST} per call.`
	);

const campaignIds = z
	.array(entityId('Campaign ID, digits only.'))
	.max(1000)
	.superRefine(unique('campaign ID'));

const termKey = (text: string, matchType: string) => `${text.toLowerCase()}|${matchType}`;

async function findList(ads: GoogleAdsClient, customerId: string, id: string) {
	const [row] = await ads.search(
		customerId,
		`SELECT shared_set.resource_name, shared_set.name, shared_set.type, shared_set.status
		FROM shared_set WHERE shared_set.id = ${id}`
	);
	const set = row?.sharedSet;
	if (!set?.resourceName || set.status === 'REMOVED')
		throw new Error(`Negative keyword list ${id} not found.`);
	if (set.type !== 'NEGATIVE_KEYWORDS')
		throw new Error(`Shared set ${id} is a ${set.type} list, not a negative keyword list.`);
	return set;
}

export const listNegativeKeywordLists = defineTool({
	name: 'list_negative_keyword_lists',
	title: 'List negative keyword lists',
	description:
		'Lists the shared negative keyword lists of an account with their size and how many campaigns use ' +
		'them, optionally with their keywords. Use it before creating a list (to reuse one) and to get list IDs.',
	input: z.object({
		customerId,
		includeKeywords: z.boolean().default(false).describe('Also return every keyword of every list.')
	}),
	output: z.object({
		lists: z.array(
			z.object({
				listId: z.string(),
				name: z.string(),
				keywordCount: z.number(),
				campaignCount: z.number(),
				keywords: z.array(z.object({ text: z.string(), matchType: z.string() })).nullable()
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, includeKeywords }, { ads }) {
		const rows = await ads.search(
			customerId,
			`SELECT shared_set.id, shared_set.name, shared_set.member_count, shared_set.reference_count
			FROM shared_set
			WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'
			ORDER BY shared_set.name`
		);
		const keywords = new Map<string, Array<{ text: string; matchType: string }>>();
		if (includeKeywords && rows.length) {
			const criteria = await ads.search(
				customerId,
				`SELECT shared_set.id, shared_criterion.keyword.text, shared_criterion.keyword.match_type
				FROM shared_criterion
				WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'
					AND shared_criterion.type = 'KEYWORD'`,
				{ maxRows: 100_000 }
			);
			for (const { sharedSet, sharedCriterion } of criteria) {
				const kw = sharedCriterion?.keyword;
				if (!sharedSet?.id || !kw?.text) continue;
				const list = keywords.get(sharedSet.id) ?? [];
				list.push({ text: kw.text, matchType: kw.matchType ?? 'UNKNOWN' });
				keywords.set(sharedSet.id, list);
			}
		}
		return {
			lists: rows.map(({ sharedSet }) => ({
				listId: sharedSet?.id ?? '',
				name: sharedSet?.name ?? '',
				keywordCount: num(sharedSet?.memberCount),
				campaignCount: num(sharedSet?.referenceCount),
				keywords: includeKeywords ? (keywords.get(sharedSet?.id ?? '') ?? []) : null
			}))
		};
	}
});

export const createNegativeKeywordList = defineTool({
	name: 'create_negative_keyword_list',
	title: 'Create negative keyword list',
	description:
		'Creates a shared negative keyword list, optionally with keywords and attached to campaigns, in one ' +
		'atomic request. A shared list keeps the same negatives in sync across campaigns; for a one-off ' +
		'negative use add_negative_keyword_to_campaign. List names must be unique in the account.',
	input: z.object({
		customerId,
		name: text(255, 'List name, unique among the account shared sets.'),
		keywords: terms.default([]),
		campaignIds: campaignIds.default([]).describe('Campaigns to attach the list to right away.'),
		validateOnly
	}),
	output: z.object({
		list: z.string().nullable().describe('Resource name; null for a dry run.'),
		listId: z.string().nullable(),
		name: z.string(),
		keywordsAdded: z.number(),
		campaignsAttached: z.array(z.string()),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, name, keywords, campaignIds, validateOnly }, { ads }) {
		const plan = new MutatePlan(customerId);
		const sharedSet = plan.tempResourceName('sharedSets');
		plan.add(negativeKeywordListOperation({ resourceName: sharedSet, name }), 'list');
		for (const keyword of keywords)
			plan.add(sharedNegativeKeywordOperation({ sharedSet, ...keyword }));
		for (const campaignId of campaignIds)
			plan.add(
				campaignSharedSetOperation({
					campaign: resourceNames.campaign(customerId, campaignId),
					sharedSet
				})
			);
		const { resourceNames: created } = await plan.publish(ads, { validateOnly });
		return {
			list: created.list ?? null,
			listId: idFromResourceName(created.list ?? undefined, 'sharedSets') ?? null,
			name,
			keywordsAdded: keywords.length,
			campaignsAttached: campaignIds,
			validateOnly
		};
	}
});

export const addKeywordsToNegativeKeywordList = defineTool({
	name: 'add_keywords_to_negative_keyword_list',
	title: 'Add keywords to negative keyword list',
	description:
		'Adds negative keywords to a shared list, which applies them to every campaign using it. Keywords ' +
		'already in the list (same text, any case, and match type) are skipped instead of failing the request.',
	input: z.object({
		customerId,
		listId,
		keywords: terms.min(1),
		validateOnly
	}),
	output: z.object({
		listId: z.string(),
		added: z.array(z.object({ text: z.string(), matchType: z.string() })),
		skippedExisting: z.array(z.object({ text: z.string(), matchType: z.string() })),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: true },
	async run({ customerId, listId, keywords, validateOnly }, { ads }) {
		const set = await findList(ads, customerId, listId);
		const existing = new Set(
			(
				await ads.search(
					customerId,
					`SELECT shared_criterion.keyword.text, shared_criterion.keyword.match_type
					FROM shared_criterion WHERE shared_criterion.shared_set = ${gaqlString(set.resourceName!)}`,
					{ maxRows: 100_000 }
				)
			).map(({ sharedCriterion: c }) =>
				termKey(c?.keyword?.text ?? '', c?.keyword?.matchType ?? '')
			)
		);
		const added = keywords.filter((k) => !existing.has(termKey(k.text, k.matchType)));
		if (added.length)
			await ads.mutate(
				customerId,
				added.map((k) => sharedNegativeKeywordOperation({ sharedSet: set.resourceName!, ...k })),
				{ validateOnly }
			);
		return {
			listId,
			added,
			skippedExisting: keywords.filter((k) => existing.has(termKey(k.text, k.matchType))),
			validateOnly
		};
	}
});

export const removeKeywordsFromNegativeKeywordList = defineTool({
	name: 'remove_keywords_from_negative_keyword_list',
	title: 'Remove keywords from negative keyword list',
	description:
		'Removes negative keywords (matched by text, any case, and match type) from a shared list, so every ' +
		'campaign using the list can show for those searches again. All must exist in the list, or nothing ' +
		'is removed and the error names the missing ones. Removal is permanent.',
	input: z.object({
		customerId,
		listId,
		keywords: terms.min(1),
		validateOnly
	}),
	output: z.object({
		listId: z.string(),
		removed: z.array(z.object({ text: z.string(), matchType: z.string() })),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: false },
	async run({ customerId, listId, keywords, validateOnly }, { ads }) {
		const set = await findList(ads, customerId, listId);
		const rows = await ads.search(
			customerId,
			`SELECT shared_criterion.resource_name, shared_criterion.keyword.text,
				shared_criterion.keyword.match_type
			FROM shared_criterion WHERE shared_criterion.shared_set = ${gaqlString(set.resourceName!)}`,
			{ maxRows: 100_000 }
		);
		const byKey = new Map(
			rows.map(({ sharedCriterion: c }) => [
				termKey(c?.keyword?.text ?? '', c?.keyword?.matchType ?? ''),
				c?.resourceName
			])
		);
		const missing = keywords.filter((k) => !byKey.get(termKey(k.text, k.matchType)));
		if (missing.length)
			throw new Error(
				`Not in list ${listId}: ${missing.map((k) => `'${k.text}' (${k.matchType})`).join(', ')}. ` +
					'Nothing was removed.'
			);
		await ads.mutate(
			customerId,
			keywords.map((k) => ({
				sharedCriterionOperation: { remove: byKey.get(termKey(k.text, k.matchType))! }
			})),
			{ validateOnly }
		);
		return { listId, removed: keywords, validateOnly };
	}
});

export const attachNegativeKeywordList = defineTool({
	name: 'attach_negative_keyword_list',
	title: 'Attach negative keyword list',
	description:
		'Applies a shared negative keyword list to campaigns. Campaigns that already use it are skipped. ' +
		'Reverse with detach_negative_keyword_list.',
	input: z.object({ customerId, listId, campaignIds: campaignIds.min(1), validateOnly }),
	output: z.object({
		listId: z.string(),
		attached: z.array(z.string()).describe('Campaign IDs newly attached (or that would be).'),
		alreadyAttached: z.array(z.string()),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: true },
	async run({ customerId, listId, campaignIds, validateOnly }, { ads }) {
		const set = await findList(ads, customerId, listId);
		const linked = await attachedCampaigns(ads, customerId, set.resourceName!);
		const attached = campaignIds.filter((id) => !linked.has(id));
		if (attached.length)
			await ads.mutate(
				customerId,
				attached.map((id) =>
					campaignSharedSetOperation({
						campaign: resourceNames.campaign(customerId, id),
						sharedSet: set.resourceName!
					})
				),
				{ validateOnly }
			);
		return {
			listId,
			attached,
			alreadyAttached: campaignIds.filter((id) => linked.has(id)),
			validateOnly
		};
	}
});

export const detachNegativeKeywordList = defineTool({
	name: 'detach_negative_keyword_list',
	title: 'Detach negative keyword list',
	description:
		'Stops campaigns from using a shared negative keyword list. The list and its keywords stay; only the ' +
		'link is removed. Every campaign must currently use the list, or nothing is detached.',
	input: z.object({ customerId, listId, campaignIds: campaignIds.min(1), validateOnly }),
	output: z.object({
		listId: z.string(),
		detached: z.array(z.string()),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: false },
	async run({ customerId, listId, campaignIds, validateOnly }, { ads }) {
		const set = await findList(ads, customerId, listId);
		const linked = await attachedCampaigns(ads, customerId, set.resourceName!);
		const missing = campaignIds.filter((id) => !linked.has(id));
		if (missing.length)
			throw new Error(
				`List ${listId} is not attached to campaign ${missing.join(', ')}. Nothing was detached.`
			);
		await ads.mutate(
			customerId,
			campaignIds.map((id) => ({ campaignSharedSetOperation: { remove: linked.get(id)! } })),
			{ validateOnly }
		);
		return { listId, detached: campaignIds, validateOnly };
	}
});

/** Campaign ID → campaign shared set resource name, for enabled links of a list. */
async function attachedCampaigns(ads: GoogleAdsClient, customerId: string, sharedSet: string) {
	const rows = await ads.search(
		customerId,
		`SELECT campaign_shared_set.resource_name, campaign_shared_set.campaign
		FROM campaign_shared_set
		WHERE campaign_shared_set.shared_set = ${gaqlString(sharedSet)}
			AND campaign_shared_set.status = 'ENABLED'`
	);
	const linked = new Map<string, string>();
	for (const { campaignSharedSet: link } of rows) {
		const campaignId = idFromResourceName(link?.campaign, 'campaigns');
		if (campaignId && link?.resourceName) linked.set(campaignId, link.resourceName);
	}
	return linked;
}
