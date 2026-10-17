import { z } from 'zod';
import { idFromResourceName } from '../resource-names.ts';
import {
	assetRef,
	attachOperations,
	linkFields,
	linkResourceNamesFor,
	linkResultName,
	linkStatus,
	listInputs,
	listLinks,
	optionalCampaignFilter,
	parseLink,
	removeOperations,
	statusOperations
} from './asset-links.ts';
import { defineTool } from './define-tool.ts';
import {
	customerId,
	entityId,
	isoDate,
	optionalText,
	text,
	unique,
	uniqueIgnoringCase,
	upperEnum,
	validateOnly
} from './schemas.ts';

const CALLOUT_CHARS = 25;
const level = upperEnum(['ACCOUNT', 'CAMPAIGN'] as const).describe(
	'ACCOUNT: links that apply to every campaign. CAMPAIGN: links on specific campaigns.'
);

const linkNames = z.array(z.string().trim().min(1)).min(1).superRefine(unique('resource name'));

export const listCallouts = defineTool({
	name: 'list_callouts',
	title: 'List callouts',
	description:
		'Lists callout links (short texts such as "Free delivery" shown under ads) at the account or campaign level, ' +
		'with their text, status and serving status. Use the returned link names with update_callout_link_status ' +
		'and remove_callout_links.',
	input: z.object({
		customerId,
		level,
		campaignId: optionalCampaignFilter.describe('Only links of this campaign (CAMPAIGN level).'),
		...listInputs
	}),
	output: z.object({
		callouts: z.array(z.object({ ...linkFields, text: z.string().nullable() }))
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, level, campaignId, includeRemoved, limit }, { ads }) {
		const links = await listLinks(ads, {
			customerId,
			level,
			fieldType: 'CALLOUT',
			assetFields: ['asset.callout_asset.callout_text'],
			campaignId,
			includeRemoved,
			limit
		});
		return {
			callouts: links.map(({ row, link }) => ({
				...link,
				text: row.asset?.calloutAsset?.calloutText ?? null
			}))
		};
	}
});

export const createCallouts = defineTool({
	name: 'create_callouts',
	title: 'Create callouts',
	description:
		'Creates callout assets (not yet shown anywhere: attach them with attach_callouts_to_campaign or ' +
		'attach_callouts_to_account). Callout text cannot be edited later; to change it, create a new callout, ' +
		'attach it and remove the old link. Check list_callouts first to reuse existing ones.',
	input: z
		.object({
			customerId,
			texts: z
				.array(text(CALLOUT_CHARS, `Callout text, at most ${CALLOUT_CHARS} characters.`))
				.min(1)
				.superRefine(uniqueIgnoringCase('callout text in request'))
				.describe(
					`Callout texts, e.g. ["Free delivery", "24/7 support"], each at most ${CALLOUT_CHARS} characters.`
				),
			startDate: isoDate.optional().describe('First day the callouts may serve, YYYY-MM-DD.'),
			endDate: isoDate.optional().describe('Last day the callouts may serve, YYYY-MM-DD.'),
			namePrefix: optionalText(
				100,
				'Asset name prefix; the name becomes "<prefix>: <text>".'
			).default('Callout'),
			validateOnly
		})
		.refine((input) => !input.startDate || !input.endDate || input.startDate <= input.endDate, {
			message: 'startDate must be on or before endDate.',
			path: ['endDate']
		}),
	output: z.object({
		callouts: z.array(
			z.object({ text: z.string(), asset: z.string().nullable(), assetId: z.string().nullable() })
		),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, texts, startDate, endDate, namePrefix, validateOnly }, { ads }) {
		const results = await ads.mutate(
			customerId,
			texts.map((calloutText) => ({
				assetOperation: {
					create: {
						name: namePrefix ? `${namePrefix}: ${calloutText}` : calloutText,
						calloutAsset: { calloutText, startDate, endDate }
					}
				}
			})),
			{ validateOnly }
		);
		return {
			callouts: texts.map((calloutText, i) => {
				const asset = results[i]?.assetResult?.resourceName ?? null;
				return {
					text: calloutText,
					asset,
					assetId: idFromResourceName(asset ?? undefined, 'assets') ?? null
				};
			}),
			validateOnly
		};
	}
});

const attachOutput = z.object({
	links: z.array(
		z.object({
			link: z.string().nullable().describe('Link resource name; null for a dry run.'),
			asset: z.string()
		})
	),
	validateOnly: z.boolean()
});

const assets = z
	.array(assetRef)
	.min(1)
	.superRefine(unique('asset'))
	.describe('Callout asset IDs or resource names, from create_callouts or list_callouts.');

export const attachCalloutsToCampaign = defineTool({
	name: 'attach_callouts_to_campaign',
	title: 'Attach callouts to campaign',
	description: 'Links existing callout assets to a campaign so they can show with its ads.',
	input: z.object({
		customerId,
		campaignId: entityId('Campaign ID, digits only.'),
		assets,
		validateOnly
	}),
	output: attachOutput,
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, campaignId, assets, validateOnly }, { ads }) {
		const results = await ads.mutate(
			customerId,
			attachOperations('CAMPAIGN', customerId, campaignId, assets, 'CALLOUT'),
			{ validateOnly }
		);
		return {
			links: assets.map((asset, i) => ({ link: linkResultName('CAMPAIGN', results[i]), asset })),
			validateOnly
		};
	}
});

export const attachCalloutsToAccount = defineTool({
	name: 'attach_callouts_to_account',
	title: 'Attach callouts to account',
	description:
		'Links existing callout assets at the account level, so they can show with ads of every campaign ' +
		'(campaign-level callouts take precedence where present).',
	input: z.object({ customerId, assets, validateOnly }),
	output: attachOutput,
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, assets, validateOnly }, { ads }) {
		const results = await ads.mutate(
			customerId,
			attachOperations('ACCOUNT', customerId, undefined, assets, 'CALLOUT'),
			{ validateOnly }
		);
		return {
			links: assets.map((asset, i) => ({ link: linkResultName('ACCOUNT', results[i]), asset })),
			validateOnly
		};
	}
});

const linkChangeOutput = z.object({
	links: z.array(
		z.object({ link: z.string(), asset: z.string().nullable(), campaignId: z.string().nullable() })
	),
	status: z.string(),
	validateOnly: z.boolean()
});

export const updateCalloutLinkStatus = defineTool({
	name: 'update_callout_link_status',
	title: 'Update callout link status',
	description:
		'Pauses or re-enables callout links (from list_callouts). The callout assets stay unchanged.',
	input: z.object({
		customerId,
		level,
		links: linkNames.describe('Link resource names from list_callouts, all of the given level.'),
		status: linkStatus,
		validateOnly
	}),
	output: linkChangeOutput,
	annotations: { readOnly: false, destructive: false, idempotent: true },
	async run({ customerId, level, links, status, validateOnly }, { ads }) {
		await ads.mutate(
			customerId,
			statusOperations(level, linkResourceNamesFor(level, customerId, links), status),
			{ validateOnly }
		);
		return {
			links: links.map((link) => {
				const { asset, campaignId } = parseLink(level, customerId, link);
				return { link, asset, campaignId };
			}),
			status,
			validateOnly
		};
	}
});

export const removeCalloutLinks = defineTool({
	name: 'remove_callout_links',
	title: 'Remove callout links',
	description:
		'Removes callout links (from list_callouts) so the callouts stop showing there. Only the links are removed; ' +
		'the callout assets remain and can be attached again.',
	input: z.object({
		customerId,
		level,
		links: linkNames.describe('Link resource names from list_callouts, all of the given level.'),
		validateOnly
	}),
	output: linkChangeOutput,
	annotations: { readOnly: false, destructive: true, idempotent: false },
	async run({ customerId, level, links, validateOnly }, { ads }) {
		await ads.mutate(
			customerId,
			removeOperations(level, linkResourceNamesFor(level, customerId, links)),
			{
				validateOnly
			}
		);
		return {
			links: links.map((link) => {
				const { asset, campaignId } = parseLink(level, customerId, link);
				return { link, asset, campaignId };
			}),
			status: 'REMOVED',
			validateOnly
		};
	}
});
