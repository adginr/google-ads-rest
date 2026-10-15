import { z } from 'zod';
import { idFromResourceName, resourceNames } from '../resource-names.ts';
import type { common } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import {
	charCount,
	customerId,
	entityId,
	optionalText,
	unique,
	uniqueIgnoringCase,
	upperEnum,
	validateOnly
} from './schemas.ts';

const HEADLINE = {
	min: 3,
	max: 15,
	chars: 30,
	positions: ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3']
} as const;
const DESCRIPTION = {
	min: 2,
	max: 4,
	chars: 90,
	positions: ['DESCRIPTION_1', 'DESCRIPTION_2']
} as const;
const RECOMMENDED_PINS_PER_POSITION = 2;

function assetTexts(label: string, spec: { min: number; max: number; chars: number }) {
	return z
		.array(
			z
				.string()
				.trim()
				.min(1, `${label} cannot be empty.`)
				.refine((value) => !/[\n\r\t]/.test(value), `${label}s cannot contain line breaks or tabs.`)
				.refine((value) => charCount(value) <= spec.chars, {
					error: (issue) =>
						`each ${label} must be ${spec.chars} characters or fewer: '${issue.input}' is ${charCount(String(issue.input))}.`
				})
		)
		.min(spec.min)
		.max(spec.max)
		.superRefine(uniqueIgnoringCase(`${label} (Google rejects identical assets in one ad)`));
}

/** One pin per asset: null, a position name, or its number ("2" → HEADLINE_2). */
function pins(prefix: 'HEADLINE' | 'DESCRIPTION', positions: readonly string[]) {
	return z
		.array(
			z.preprocess(
				(value) => {
					if (typeof value !== 'string') return value;
					const upper = value.trim().toUpperCase();
					if (['', 'NONE', 'NULL', 'UNPINNED', 'UNSPECIFIED'].includes(upper)) return null;
					return /^\d+$/.test(upper) ? `${prefix}_${upper}` : upper;
				},
				z.enum(positions as [string, ...string[]]).nullable()
			)
		)
		.optional();
}

const displayPath = optionalText(15, 'Display URL path segment, at most 15 characters.').refine(
	(value) => value === undefined || !/[\s/?#&%]/.test(value),
	'display paths are one segment: no spaces (use a hyphen) and no / ? # & % characters.'
);

const finalUrl = z
	.string()
	.trim()
	.max(2048)
	.refine((value) => {
		if (/\s/.test(value) || !/^https?:\/\//i.test(value)) return false;
		try {
			return new URL(value).hostname.includes('.');
		} catch {
			return false;
		}
	}, 'must be an absolute http(s) URL with a full domain and no spaces, e.g. https://example.com/page.');

/** Advisory only: pinning narrows Google's combinations and usually lowers Ad Strength. */
function pinWarnings(
	assigned: Array<string | null>,
	positions: readonly string[],
	label: string
): string[] {
	const pinned = assigned.filter((pin) => pin !== null);
	if (!pinned.length) return [];
	const warnings: string[] = [];
	for (const position of positions) {
		const count = pinned.filter((pin) => pin === position).length;
		if (count > 0 && count < RECOMMENDED_PINS_PER_POSITION) {
			warnings.push(
				`only ${count} ${label} is pinned to ${position}; Google recommends at least ` +
					`${RECOMMENDED_PINS_PER_POSITION} per pinned position so the ad keeps some flexibility.`
			);
		}
	}
	if (pinned.length === assigned.length) {
		warnings.push(
			`all ${assigned.length} ${label}s are pinned, which stops Google from testing combinations and usually lowers Ad Strength.`
		);
	}
	return warnings;
}

const adGroupId = entityId('Ad group ID, digits only.');

export const createResponsiveSearchAd = defineTool({
	name: 'create_responsive_search_ad',
	title: 'Create responsive search ad',
	description:
		'Creates a Responsive Search Ad in an existing search ad group, PAUSED by default (an enabled ad group would ' +
		'start spending on it at once; enable it with update_ad_status after review). Ad text and URLs cannot be ' +
		'edited after creation: to change copy, create a new ad and pause or remove the old one. Call ' +
		'list_ads_in_ad_group first to avoid repeating existing copy. Aim for 8-15 distinct headlines and 4 ' +
		'descriptions that each read well next to any other. Pinning is optional and discouraged; the result ' +
		'lists warnings about risky pins.',
	input: z
		.object({
			customerId,
			adGroupId,
			headlines: assetTexts('headline', HEADLINE).describe(
				`${HEADLINE.min}-${HEADLINE.max} headlines, each at most ${HEADLINE.chars} characters, unique.`
			),
			descriptions: assetTexts('description', DESCRIPTION).describe(
				`${DESCRIPTION.min}-${DESCRIPTION.max} descriptions, each at most ${DESCRIPTION.chars} characters, unique.`
			),
			finalUrls: z
				.array(finalUrl)
				.min(1)
				.superRefine(unique('final URL'))
				.describe('Landing page URLs; usually one, e.g. ["https://example.com/offer"].'),
			headlinePins: pins('HEADLINE', HEADLINE.positions).describe(
				'Optional, exactly one entry per headline in the same order: null (unpinned) or HEADLINE_1..3 ' +
					'("1".."3" accepted). Omit to leave all unpinned (recommended).'
			),
			descriptionPins: pins('DESCRIPTION', DESCRIPTION.positions).describe(
				'Optional, one entry per description: null or DESCRIPTION_1..2.'
			),
			path1: displayPath.describe(
				'Display path after the domain, e.g. "car-leasing" → example.com/car-leasing.'
			),
			path2: displayPath.describe('Second display path segment; requires path1.'),
			status: upperEnum(['ENABLED', 'PAUSED'] as const).default('PAUSED'),
			validateOnly
		})
		.superRefine((input, ctx) => {
			if (input.path2 && !input.path1) {
				ctx.addIssue({ code: 'custom', path: ['path2'], message: 'path2 requires path1.' });
			}
			for (const [key, assets] of [
				['headlinePins', input.headlines],
				['descriptionPins', input.descriptions]
			] as const) {
				const list = input[key];
				if (list && list.length !== assets.length) {
					ctx.addIssue({
						code: 'custom',
						path: [key],
						message: `needs exactly one entry per asset: got ${list.length} for ${assets.length}. Use null for unpinned.`
					});
				}
			}
		}),
	output: z.object({
		ad: z.string().nullable().describe('Ad group ad resource name; null for a dry run.'),
		adId: z.string().nullable(),
		adGroupId: z.string(),
		status: z.string(),
		warnings: z.array(z.string()),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run(input, { ads }) {
		const { customerId, adGroupId, status, validateOnly } = input;
		const headlinePins = input.headlinePins ?? input.headlines.map(() => null);
		const descriptionPins = input.descriptionPins ?? input.descriptions.map(() => null);
		const assets = (texts: string[], assigned: Array<string | null>): common.AdTextAsset[] =>
			texts.map((text, i) =>
				assigned[i]
					? { text, pinnedField: assigned[i] as common.AdTextAsset['pinnedField'] }
					: { text }
			);

		const [result] = await ads.mutate(
			customerId,
			[
				{
					adGroupAdOperation: {
						create: {
							adGroup: resourceNames.adGroup(customerId, adGroupId),
							status,
							ad: {
								finalUrls: input.finalUrls,
								responsiveSearchAd: {
									headlines: assets(input.headlines, headlinePins),
									descriptions: assets(input.descriptions, descriptionPins),
									...(input.path1 ? { path1: input.path1 } : {}),
									...(input.path2 ? { path2: input.path2 } : {})
								}
							}
						}
					}
				}
			],
			{ validateOnly }
		);
		const ad = result?.adGroupAdResult?.resourceName ?? null;
		return {
			ad,
			adId: idFromResourceName(ad ?? undefined, 'adGroupAds') ?? null,
			adGroupId,
			status,
			warnings: [
				...pinWarnings(headlinePins, HEADLINE.positions, 'headline'),
				...pinWarnings(descriptionPins, DESCRIPTION.positions, 'description')
			],
			validateOnly
		};
	}
});

export const updateAdStatus = defineTool({
	name: 'update_ad_status',
	title: 'Update ad status',
	description:
		'Sets an ad to ENABLED, PAUSED or REMOVED: the only change possible on an existing ad, and how an old ad is ' +
		'retired after its replacement was created. REMOVED is permanent and its copy cannot be recovered, so prefer ' +
		'PAUSED unless the user asked to delete it. Get IDs from list_ads_in_ad_group.',
	input: z.object({
		customerId,
		adGroupId: entityId('Ad group ID: the first number in customers/1/adGroupAds/111~222.'),
		adId: entityId('Ad ID: the part after "~" in customers/1/adGroupAds/111~222.'),
		status: upperEnum(['ENABLED', 'PAUSED', 'REMOVED'] as const).describe(
			'No default on purpose: each value affects spend differently.'
		),
		validateOnly
	}),
	output: z.object({
		ad: z.string().nullable().describe('Resource name; null for a dry run.'),
		adGroupId: z.string(),
		adId: z.string(),
		status: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: true },
	async run({ customerId, adGroupId, adId, status, validateOnly }, { ads }) {
		const resourceName = resourceNames.adGroupAd(customerId, adGroupId, adId);
		// REMOVED cannot be set by update (INVALID_ENUM_VALUE); removal is its own operation.
		const [result] = await ads.mutate(
			customerId,
			[
				{
					adGroupAdOperation:
						status === 'REMOVED'
							? { remove: resourceName }
							: { update: { resourceName, status }, updateMask: 'status' }
				}
			],
			{ validateOnly }
		);
		return {
			ad: result?.adGroupAdResult?.resourceName ?? null,
			adGroupId,
			adId,
			status,
			validateOnly
		};
	}
});

export const listAdsInAdGroup = defineTool({
	name: 'list_ads_in_ad_group',
	title: 'List ads in ad group',
	description:
		'Lists the ads of an ad group with status, Ad Strength and full responsive search ad copy (headlines, ' +
		'descriptions, pins, URLs, paths). Use it before writing a replacement ad and to get the adId for ' +
		'update_ad_status. Non-RSA ads come back with empty copy.',
	input: z.object({
		customerId,
		adGroupId,
		includeRemoved: z
			.boolean()
			.default(false)
			.describe('Also return removed ads (read-only history).'),
		limit: z.number().int().positive().max(1000).default(50)
	}),
	output: z.object({
		ads: z.array(
			z.object({
				adId: z.string(),
				status: z.string().nullable(),
				type: z.string().nullable(),
				adStrength: z.string().nullable(),
				headlines: z.array(z.object({ text: z.string(), pin: z.string().nullable() })),
				descriptions: z.array(z.object({ text: z.string(), pin: z.string().nullable() })),
				finalUrls: z.array(z.string()),
				path1: z.string().nullable(),
				path2: z.string().nullable()
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, adGroupId, includeRemoved, limit }, { ads }) {
		const rows = await ads.search(
			customerId,
			`SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad_strength,
				ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls,
				ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions,
				ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2
			FROM ad_group_ad
			WHERE ad_group_ad.ad_group = '${resourceNames.adGroup(customerId, adGroupId)}'
				${includeRemoved ? '' : "AND ad_group_ad.status != 'REMOVED'"}
			ORDER BY ad_group_ad.ad.id
			LIMIT ${limit}`
		);
		const positions = new Set<string>([...HEADLINE.positions, ...DESCRIPTION.positions]);
		const copy = (list: common.AdTextAsset[] | undefined) =>
			(list ?? []).map(({ text, pinnedField }) => ({
				text: text ?? '',
				pin: pinnedField && positions.has(pinnedField) ? pinnedField : null
			}));
		return {
			ads: rows.map(({ adGroupAd }) => {
				const ad = adGroupAd?.ad;
				const rsa = ad?.responsiveSearchAd;
				return {
					adId: ad?.id ?? idFromResourceName(adGroupAd?.resourceName, 'adGroupAds') ?? '',
					status: adGroupAd?.status ?? null,
					type: ad?.type ?? null,
					adStrength: adGroupAd?.adStrength ?? null,
					headlines: copy(rsa?.headlines),
					descriptions: copy(rsa?.descriptions),
					finalUrls: (ad?.finalUrls ?? []).filter(Boolean),
					path1: rsa?.path1 ?? null,
					path2: rsa?.path2 ?? null
				};
			})
		};
	}
});
