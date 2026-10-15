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
	optionalText,
	text,
	unique,
	upperEnum,
	validateOnly
} from './schemas.ts';

const LINK_TEXT_CHARS = 25;
const DESCRIPTION_CHARS = 35;
const level = upperEnum(['CAMPAIGN', 'AD_GROUP'] as const).describe(
	'CAMPAIGN: links on campaigns. AD_GROUP: links on ad groups (they override campaign sitelinks there).'
);

const linkNames = z.array(z.string().trim().min(1)).min(1).superRefine(unique('resource name'));

const sitelink = z
	.object({
		linkText: text(LINK_TEXT_CHARS, `Visible link text, at most ${LINK_TEXT_CHARS} characters.`),
		finalUrl: z.url({ protocol: /^https?$/ }).describe('Landing page of this sitelink.'),
		description1: optionalText(
			DESCRIPTION_CHARS,
			`First description line, at most ${DESCRIPTION_CHARS} characters.`
		),
		description2: optionalText(
			DESCRIPTION_CHARS,
			`Second description line, at most ${DESCRIPTION_CHARS} characters.`
		)
	})
	.refine((s) => !s.description1 === !s.description2, {
		message: 'Set both description1 and description2, or neither.'
	});

export const listSitelinks = defineTool({
	name: 'list_sitelinks',
	title: 'List sitelinks',
	description:
		'Lists sitelink links (extra links under ads) at the campaign or ad group level, with text, descriptions, ' +
		'URL, status and serving status. Use the returned link names with update_sitelink_link_status and ' +
		'remove_sitelink_links.',
	input: z
		.object({
			customerId,
			level,
			campaignId: optionalCampaignFilter,
			adGroupId: entityId('Only links of this ad group (AD_GROUP level).').optional(),
			...listInputs
		})
		.refine((input) => !input.adGroupId || input.level === 'AD_GROUP', {
			message: 'adGroupId can only be used when level is AD_GROUP.',
			path: ['adGroupId']
		}),
	output: z.object({
		sitelinks: z.array(
			z.object({
				...linkFields,
				linkText: z.string().nullable(),
				description1: z.string().nullable(),
				description2: z.string().nullable(),
				finalUrl: z.string().nullable()
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, level, campaignId, adGroupId, includeRemoved, limit }, { ads }) {
		const links = await listLinks(ads, {
			customerId,
			level,
			fieldType: 'SITELINK',
			assetFields: [
				'asset.final_urls',
				'asset.sitelink_asset.link_text',
				'asset.sitelink_asset.description1',
				'asset.sitelink_asset.description2'
			],
			campaignId,
			adGroupId,
			includeRemoved,
			limit
		});
		return {
			sitelinks: links.map(({ row, link }) => ({
				...link,
				linkText: row.asset?.sitelinkAsset?.linkText ?? null,
				description1: row.asset?.sitelinkAsset?.description1 ?? null,
				description2: row.asset?.sitelinkAsset?.description2 ?? null,
				finalUrl: row.asset?.finalUrls?.[0] ?? null
			}))
		};
	}
});

export const createSitelinks = defineTool({
	name: 'create_sitelinks',
	title: 'Create sitelinks',
	description:
		'Creates sitelink assets (not yet shown anywhere: attach them with attach_sitelinks_to_campaign or ' +
		'attach_sitelinks_to_ad_group). Text and URL cannot be edited later; to change one, create a replacement, ' +
		'attach it and remove the old link. Check list_sitelinks first to reuse existing ones.',
	input: z.object({
		customerId,
		sitelinks: z
			.array(sitelink)
			.min(1)
			.superRefine((items, ctx) => {
				const seen = new Set<string>();
				for (const { linkText } of items) {
					const key = linkText.toLowerCase();
					if (seen.has(key))
						ctx.addIssue({ code: 'custom', message: `duplicate linkText: '${linkText}'.` });
					seen.add(key);
				}
			}),
		namePrefix: optionalText(
			100,
			'Asset name prefix; the name becomes "<prefix>: <linkText>".'
		).default('Sitelink'),
		validateOnly
	}),
	output: z.object({
		sitelinks: z.array(
			z.object({
				linkText: z.string(),
				asset: z.string().nullable(),
				assetId: z.string().nullable()
			})
		),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, sitelinks, namePrefix, validateOnly }, { ads }) {
		const results = await ads.mutate(
			customerId,
			sitelinks.map(({ linkText, finalUrl, description1, description2 }) => ({
				assetOperation: {
					create: {
						name: namePrefix ? `${namePrefix}: ${linkText}` : linkText,
						finalUrls: [finalUrl],
						sitelinkAsset: { linkText, description1, description2 }
					}
				}
			})),
			{ validateOnly }
		);
		return {
			sitelinks: sitelinks.map(({ linkText }, i) => {
				const asset = results[i]?.assetResult?.resourceName ?? null;
				return {
					linkText,
					asset,
					assetId: idFromResourceName(asset ?? undefined, 'assets') ?? null
				};
			}),
			validateOnly
		};
	}
});

const assets = z
	.array(assetRef)
	.min(1)
	.superRefine(unique('asset'))
	.describe('Sitelink asset IDs or resource names, from create_sitelinks or list_sitelinks.');

const attachOutput = z.object({
	links: z.array(
		z.object({
			link: z.string().nullable().describe('Link resource name; null for a dry run.'),
			asset: z.string()
		})
	),
	validateOnly: z.boolean()
});

export const attachSitelinksToCampaign = defineTool({
	name: 'attach_sitelinks_to_campaign',
	title: 'Attach sitelinks to campaign',
	description: 'Links existing sitelink assets to a campaign so they can show with its ads.',
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
			attachOperations('CAMPAIGN', customerId, campaignId, assets, 'SITELINK'),
			{ validateOnly }
		);
		return {
			links: assets.map((asset, i) => ({ link: linkResultName('CAMPAIGN', results[i]), asset })),
			validateOnly
		};
	}
});

export const attachSitelinksToAdGroup = defineTool({
	name: 'attach_sitelinks_to_ad_group',
	title: 'Attach sitelinks to ad group',
	description:
		'Links existing sitelink assets to an ad group. Ad group sitelinks replace the campaign sitelinks for that ad group.',
	input: z.object({
		customerId,
		adGroupId: entityId('Ad group ID, digits only.'),
		assets,
		validateOnly
	}),
	output: attachOutput,
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, adGroupId, assets, validateOnly }, { ads }) {
		const results = await ads.mutate(
			customerId,
			attachOperations('AD_GROUP', customerId, adGroupId, assets, 'SITELINK'),
			{ validateOnly }
		);
		return {
			links: assets.map((asset, i) => ({ link: linkResultName('AD_GROUP', results[i]), asset })),
			validateOnly
		};
	}
});

const linkChangeOutput = z.object({
	links: z.array(
		z.object({
			link: z.string(),
			asset: z.string().nullable(),
			campaignId: z.string().nullable(),
			adGroupId: z.string().nullable()
		})
	),
	status: z.string(),
	validateOnly: z.boolean()
});

export const updateSitelinkLinkStatus = defineTool({
	name: 'update_sitelink_link_status',
	title: 'Update sitelink link status',
	description:
		'Pauses or re-enables sitelink links (from list_sitelinks). The sitelink assets stay unchanged.',
	input: z.object({
		customerId,
		level,
		links: linkNames.describe('Link resource names from list_sitelinks, all of the given level.'),
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
				const { asset, campaignId, adGroupId } = parseLink(level, customerId, link);
				return { link, asset, campaignId, adGroupId };
			}),
			status,
			validateOnly
		};
	}
});

export const removeSitelinkLinks = defineTool({
	name: 'remove_sitelink_links',
	title: 'Remove sitelink links',
	description:
		'Removes sitelink links (from list_sitelinks) so the sitelinks stop showing there. Only the links are ' +
		'removed; the sitelink assets remain and can be attached again.',
	input: z.object({
		customerId,
		level,
		links: linkNames.describe('Link resource names from list_sitelinks, all of the given level.'),
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
				const { asset, campaignId, adGroupId } = parseLink(level, customerId, link);
				return { link, asset, campaignId, adGroupId };
			}),
			status: 'REMOVED',
			validateOnly
		};
	}
});
