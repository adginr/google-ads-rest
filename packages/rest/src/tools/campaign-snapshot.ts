import { z } from 'zod';
import type { GoogleAdsRow } from '../client.ts';
import type { common } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import { customerId, entityId, fromMicros, num } from './schemas.ts';

const MAX_ROWS = 100_000;
const MINUTES = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 } as const;
const PINS = new Set(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', 'DESCRIPTION_1', 'DESCRIPTION_2']);

const nullableString = z.string().nullable();
const term = z.object({ text: z.string(), matchType: z.string() });
const copy = z.array(z.object({ text: z.string(), pin: nullableString }));
const linkBase = {
	assetId: z.string(),
	status: nullableString.describe('Link status: ENABLED or PAUSED.')
};
const assetsSchema = z.object({
	sitelinks: z.array(
		z.object({
			...linkBase,
			linkText: nullableString,
			description1: nullableString,
			description2: nullableString,
			finalUrl: nullableString
		})
	),
	callouts: z.array(z.object({ ...linkBase, text: nullableString })),
	structuredSnippets: z.array(
		z.object({ ...linkBase, header: nullableString, values: z.array(z.string()) })
	)
});
type Assets = z.infer<typeof assetsSchema>;

const proximitySchema = z.object({
	latitude: z.number().nullable(),
	longitude: z.number().nullable(),
	radius: z.number().nullable(),
	radiusUnits: nullableString.describe('KILOMETERS or MILES.'),
	address: nullableString.describe('Street, postal code, city, country, as set on the target.'),
	negative: z.boolean(),
	bidModifier: z.number().nullable()
});

const locationSchema = z.object({
	id: z.number(),
	name: nullableString,
	canonicalName: nullableString,
	targetType: nullableString,
	bidModifier: z.number().nullable()
});

export const getCampaignSnapshot = defineTool({
	name: 'get_campaign_snapshot',
	title: 'Get campaign snapshot',
	description:
		'Reads one campaign completely in a single call: settings (bidding, networks, dates, location ' +
		'targeting mode), budget, location/language/device/ad schedule criteria, every non-removed ad group ' +
		'with its keywords, negatives and responsive search ads (with pins), campaign negatives, attached shared ' +
		'negative keyword lists with their keywords, and sitelinks, callouts and structured snippets linked to ' +
		'the campaign or its ad groups. Use it to copy or template a campaign, to review its structure, or to ' +
		'compare it with a planned version. Removed entities and account-level assets are left out; money is ' +
		'in account currency units.',
	input: z.object({
		customerId,
		campaignId: entityId('Campaign ID, digits only. Get it from list_campaigns.')
	}),
	output: z.object({
		customerId: z.string(),
		currencyCode: nullableString,
		timeZone: nullableString,
		campaign: z.object({
			id: z.string(),
			name: z.string(),
			status: nullableString,
			channelType: nullableString,
			channelSubType: nullableString,
			bidding: z.object({
				strategy: nullableString.describe(
					'e.g. TARGET_SPEND (Maximize clicks), MAXIMIZE_CONVERSIONS, MANUAL_CPC.'
				),
				portfolioStrategy: nullableString.describe('Resource name of a shared bidding strategy.'),
				maxCpcBidCeiling: z.number().nullable(),
				targetCpa: z.number().nullable(),
				targetRoas: z.number().nullable(),
				targetImpressionShare: z
					.object({ location: nullableString, fraction: z.number().nullable() })
					.nullable(),
				enhancedCpc: z.boolean().nullable()
			}),
			networks: z.object({
				googleSearch: z.boolean(),
				searchPartners: z.boolean(),
				displayNetwork: z.boolean()
			}),
			locationTargeting: nullableString.describe('PRESENCE or PRESENCE_OR_INTEREST.'),
			locationExclusion: nullableString,
			startDate: nullableString.describe('YYYY-MM-DD in the account time zone.'),
			endDate: nullableString,
			containsEuPoliticalAdvertising: z.boolean().nullable(),
			trackingUrlTemplate: nullableString,
			finalUrlSuffix: nullableString
		}),
		budget: z
			.object({
				id: z.string(),
				name: nullableString,
				dailyAmount: z.number().nullable(),
				explicitlyShared: z.boolean(),
				sharedByCampaigns: z.number(),
				deliveryMethod: nullableString
			})
			.nullable(),
		targeting: z.object({
			locations: z.array(locationSchema),
			excludedLocations: z.array(locationSchema),
			radius: z.array(proximitySchema).describe('Radius (proximity) targets around a point.'),
			languages: z.array(z.object({ id: z.number(), name: nullableString, code: nullableString })),
			devices: z.array(z.object({ device: z.string(), bidModifier: z.number().nullable() })),
			adSchedule: z.array(
				z.object({
					dayOfWeek: z.string(),
					startHour: z.number(),
					startMinute: z.number(),
					endHour: z.number(),
					endMinute: z.number(),
					bidModifier: z.number().nullable()
				})
			)
		}),
		negatives: z.object({
			campaign: z.array(term),
			sharedLists: z.array(
				z.object({ listId: z.string(), name: z.string(), keywords: z.array(term) })
			)
		}),
		adGroups: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				status: nullableString,
				type: nullableString,
				cpcBid: z.number().nullable(),
				keywords: z.array(
					z.object({
						criterionId: z.string(),
						text: z.string(),
						matchType: z.string(),
						status: nullableString,
						cpcBid: z.number().nullable(),
						finalUrl: nullableString
					})
				),
				negatives: z.array(term),
				ads: z.array(
					z.object({
						adId: z.string(),
						status: nullableString,
						type: nullableString,
						adStrength: nullableString,
						headlines: copy,
						descriptions: copy,
						finalUrls: z.array(z.string()),
						path1: nullableString,
						path2: nullableString
					})
				),
				assets: assetsSchema
			})
		),
		assets: assetsSchema.describe('Assets linked to the campaign itself.')
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, campaignId }, { ads }) {
		// Some resources require fields used in WHERE to be selected too (EXPECTED_REFERENCED_FIELD_IN_SELECT_CLAUSE).
		const inCampaign = `campaign.id = ${campaignId}`;
		const search = (query: string) => ads.search(customerId, query, { maxRows: MAX_ROWS });
		const [
			[head],
			criteria,
			adGroups,
			keywords,
			adRows,
			sharedSets,
			campaignAssets,
			adGroupAssets
		] = await Promise.all([
			search(
				`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
						campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.bidding_strategy,
						campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros,
						campaign.target_cpa.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
						campaign.target_roas.target_roas, campaign.target_impression_share.location,
						campaign.target_impression_share.location_fraction_micros,
						campaign.target_impression_share.cpc_bid_ceiling_micros, campaign.manual_cpc.enhanced_cpc_enabled,
						campaign.network_settings.target_google_search, campaign.network_settings.target_search_network,
						campaign.network_settings.target_content_network,
						campaign.geo_target_type_setting.positive_geo_target_type,
						campaign.geo_target_type_setting.negative_geo_target_type, campaign.start_date_time,
						campaign.end_date_time, campaign.contains_eu_political_advertising,
						campaign.tracking_url_template, campaign.final_url_suffix, campaign_budget.id,
						campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared,
						campaign_budget.reference_count, campaign_budget.delivery_method, customer.currency_code,
						customer.time_zone
					FROM campaign WHERE ${inCampaign}`
			),
			search(
				`SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.status,
						campaign_criterion.negative,
						campaign_criterion.bid_modifier, campaign_criterion.location.geo_target_constant,
						campaign_criterion.language.language_constant, campaign_criterion.device.type,
						campaign_criterion.ad_schedule.day_of_week, campaign_criterion.ad_schedule.start_hour,
						campaign_criterion.ad_schedule.start_minute, campaign_criterion.ad_schedule.end_hour,
						campaign_criterion.ad_schedule.end_minute, campaign_criterion.keyword.text,
						campaign_criterion.keyword.match_type, campaign_criterion.proximity.radius,
						campaign_criterion.proximity.radius_units,
						campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
						campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
						campaign_criterion.proximity.address.street_address,
						campaign_criterion.proximity.address.city_name,
						campaign_criterion.proximity.address.postal_code,
						campaign_criterion.proximity.address.country_code
					FROM campaign_criterion
					WHERE ${inCampaign} AND campaign_criterion.status != 'REMOVED'
						AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LANGUAGE', 'DEVICE', 'AD_SCHEDULE', 'KEYWORD')`
			),
			search(
				`SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros
					FROM ad_group WHERE ${inCampaign} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`
			),
			search(
				`SELECT campaign.id, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type,
						ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.keyword.text,
						ad_group_criterion.keyword.match_type, ad_group_criterion.cpc_bid_micros,
						ad_group_criterion.final_urls
					FROM ad_group_criterion
					WHERE ${inCampaign} AND ad_group.status != 'REMOVED'
						AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'
					ORDER BY ad_group_criterion.criterion_id`
			),
			search(
				`SELECT campaign.id, ad_group.id, ad_group.status, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.ad.id,
						ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
						ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1,
						ad_group_ad.ad.responsive_search_ad.path2
					FROM ad_group_ad
					WHERE ${inCampaign} AND ad_group.status != 'REMOVED' AND ad_group_ad.status != 'REMOVED'
					ORDER BY ad_group_ad.ad.id`
			),
			search(
				`SELECT campaign.id, shared_set.id, shared_set.name, shared_set.type, shared_set.status,
						campaign_shared_set.status
					FROM campaign_shared_set
					WHERE ${inCampaign} AND campaign_shared_set.status = 'ENABLED'
						AND shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'`
			),
			search(assetQuery('campaign_asset', inCampaign)),
			search(
				assetQuery(
					'ad_group_asset',
					`${inCampaign} AND ad_group.status != 'REMOVED'`,
					'ad_group.id, ad_group.status'
				)
			)
		]);
		if (!head?.campaign) throw new Error(`Campaign ${campaignId} not found.`);

		const geoIds = new Set<string>();
		const languageIds = new Set<string>();
		for (const { campaignCriterion: c } of criteria) {
			const geo = constantId(c?.location?.geoTargetConstant);
			const language = constantId(c?.language?.languageConstant);
			if (geo) geoIds.add(geo);
			if (language) languageIds.add(language);
		}
		const [geoRows, languageRows, sharedTerms] = await Promise.all([
			geoIds.size
				? search(
						`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name,
							geo_target_constant.target_type
						FROM geo_target_constant WHERE geo_target_constant.id IN (${[...geoIds].join(', ')})`
					)
				: [],
			languageIds.size
				? search(
						`SELECT language_constant.id, language_constant.name, language_constant.code
						FROM language_constant WHERE language_constant.id IN (${[...languageIds].join(', ')})`
					)
				: [],
			sharedSets.length
				? search(
						`SELECT shared_set.id, shared_criterion.type, shared_criterion.keyword.text,
							shared_criterion.keyword.match_type
						FROM shared_criterion
						WHERE shared_set.id IN (${sharedSets.map((row) => row.sharedSet?.id).join(', ')})
							AND shared_criterion.type = 'KEYWORD'`
					)
				: []
		]);

		const geos = new Map(geoRows.map(({ geoTargetConstant: g }) => [g?.id, g]));
		const languages = new Map(languageRows.map(({ languageConstant: l }) => [l?.id, l]));
		const targeting = {
			locations: [] as z.infer<typeof locationSchema>[],
			excludedLocations: [] as z.infer<typeof locationSchema>[],
			radius: [] as z.infer<typeof proximitySchema>[],
			languages: [] as Array<{ id: number; name: string | null; code: string | null }>,
			devices: [] as Array<{ device: string; bidModifier: number | null }>,
			adSchedule: [] as Array<{
				dayOfWeek: string;
				startHour: number;
				startMinute: number;
				endHour: number;
				endMinute: number;
				bidModifier: number | null;
			}>
		};
		const campaignNegatives: Array<{ text: string; matchType: string }> = [];
		for (const { campaignCriterion: c } of criteria) {
			const bidModifier = c?.bidModifier ?? null;
			if (c?.type === 'LOCATION') {
				const id = constantId(c.location?.geoTargetConstant);
				if (!id) continue;
				const geo = geos.get(id);
				(c.negative ? targeting.excludedLocations : targeting.locations).push({
					id: Number(id),
					name: geo?.name ?? null,
					canonicalName: geo?.canonicalName ?? null,
					targetType: geo?.targetType ?? null,
					bidModifier
				});
			} else if (c?.type === 'PROXIMITY' && c.proximity) {
				const { geoPoint, address } = c.proximity;
				const degrees = (micro: number | undefined) => (micro === undefined ? null : micro / 1e6);
				targeting.radius.push({
					latitude: degrees(geoPoint?.latitudeInMicroDegrees),
					longitude: degrees(geoPoint?.longitudeInMicroDegrees),
					radius: c.proximity.radius ?? null,
					radiusUnits: c.proximity.radiusUnits ?? null,
					address:
						[address?.streetAddress, address?.postalCode, address?.cityName, address?.countryCode]
							.filter(Boolean)
							.join(', ') || null,
					negative: Boolean(c.negative),
					bidModifier
				});
			} else if (c?.type === 'LANGUAGE') {
				const id = constantId(c.language?.languageConstant);
				if (!id) continue;
				const language = languages.get(id);
				targeting.languages.push({
					id: Number(id),
					name: language?.name ?? null,
					code: language?.code ?? null
				});
			} else if (c?.type === 'DEVICE' && c.device?.type) {
				targeting.devices.push({ device: c.device.type, bidModifier });
			} else if (c?.type === 'AD_SCHEDULE' && c.adSchedule?.dayOfWeek) {
				const s = c.adSchedule;
				targeting.adSchedule.push({
					dayOfWeek: s.dayOfWeek!,
					startHour: s.startHour ?? 0,
					startMinute: minutes(s.startMinute),
					endHour: s.endHour ?? 0,
					endMinute: minutes(s.endMinute),
					bidModifier
				});
			} else if (c?.type === 'KEYWORD' && c.negative && c.keyword?.text) {
				campaignNegatives.push(toTerm(c.keyword));
			}
		}

		const sharedKeywords = new Map<string, Array<{ text: string; matchType: string }>>();
		for (const { sharedSet, sharedCriterion } of sharedTerms) {
			if (!sharedSet?.id || !sharedCriterion?.keyword?.text) continue;
			const list = sharedKeywords.get(sharedSet.id) ?? [];
			list.push(toTerm(sharedCriterion.keyword));
			sharedKeywords.set(sharedSet.id, list);
		}

		const groups = new Map(
			adGroups.map(({ adGroup: g }) => [
				g?.id ?? '',
				{
					id: g?.id ?? '',
					name: g?.name ?? '',
					status: g?.status ?? null,
					type: g?.type ?? null,
					cpcBid: fromMicros(g?.cpcBidMicros),
					keywords: [] as Array<{
						criterionId: string;
						text: string;
						matchType: string;
						status: string | null;
						cpcBid: number | null;
						finalUrl: string | null;
					}>,
					negatives: [] as Array<{ text: string; matchType: string }>,
					ads: [] as Array<ReturnType<typeof toAd>>,
					assets: emptyAssets()
				}
			])
		);
		for (const { adGroup, adGroupCriterion: k } of keywords) {
			const group = groups.get(adGroup?.id ?? '');
			if (!group || !k?.keyword?.text) continue;
			if (k.negative) group.negatives.push(toTerm(k.keyword));
			else
				group.keywords.push({
					criterionId: k.criterionId ?? '',
					...toTerm(k.keyword),
					status: k.status ?? null,
					cpcBid: fromMicros(k.cpcBidMicros),
					finalUrl: k.finalUrls?.[0] ?? null
				});
		}
		for (const row of adRows) groups.get(row.adGroup?.id ?? '')?.ads.push(toAd(row));

		const assets = emptyAssets();
		for (const row of campaignAssets) addAsset(assets, row, row.campaignAsset);
		for (const row of adGroupAssets) {
			const group = groups.get(row.adGroup?.id ?? '');
			if (group) addAsset(group.assets, row, row.adGroupAsset);
		}

		const c = head.campaign;
		const budget = head.campaignBudget;
		const eu = c.containsEuPoliticalAdvertising;
		return {
			customerId,
			currencyCode: head.customer?.currencyCode ?? null,
			timeZone: head.customer?.timeZone ?? null,
			campaign: {
				id: c.id ?? campaignId,
				name: c.name ?? '',
				status: c.status ?? null,
				channelType: c.advertisingChannelType ?? null,
				channelSubType: c.advertisingChannelSubType ?? null,
				bidding: {
					strategy: c.biddingStrategyType ?? null,
					portfolioStrategy: c.biddingStrategy ?? null,
					maxCpcBidCeiling: fromMicros(
						c.targetSpend?.cpcBidCeilingMicros ?? c.targetImpressionShare?.cpcBidCeilingMicros
					),
					targetCpa: fromMicros(
						c.maximizeConversions?.targetCpaMicros ?? c.targetCpa?.targetCpaMicros
					),
					targetRoas: c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas ?? null,
					targetImpressionShare: c.targetImpressionShare
						? {
								location: c.targetImpressionShare.location ?? null,
								fraction: fromMicros(c.targetImpressionShare.locationFractionMicros)
							}
						: null,
					enhancedCpc: c.manualCpc ? Boolean(c.manualCpc.enhancedCpcEnabled) : null
				},
				networks: {
					googleSearch: Boolean(c.networkSettings?.targetGoogleSearch),
					searchPartners: Boolean(c.networkSettings?.targetSearchNetwork),
					displayNetwork: Boolean(c.networkSettings?.targetContentNetwork)
				},
				locationTargeting: c.geoTargetTypeSetting?.positiveGeoTargetType ?? null,
				locationExclusion: c.geoTargetTypeSetting?.negativeGeoTargetType ?? null,
				startDate: c.startDateTime?.slice(0, 10) ?? null,
				endDate: c.endDateTime?.slice(0, 10) ?? null,
				containsEuPoliticalAdvertising:
					eu === 'CONTAINS_EU_POLITICAL_ADVERTISING'
						? true
						: eu === 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'
							? false
							: null,
				trackingUrlTemplate: c.trackingUrlTemplate || null,
				finalUrlSuffix: c.finalUrlSuffix || null
			},
			budget: budget?.id
				? {
						id: budget.id,
						name: budget.name ?? null,
						dailyAmount: fromMicros(budget.amountMicros ?? '0'),
						explicitlyShared: Boolean(budget.explicitlyShared),
						sharedByCampaigns: num(budget.referenceCount),
						deliveryMethod: budget.deliveryMethod ?? null
					}
				: null,
			targeting,
			negatives: {
				campaign: campaignNegatives,
				sharedLists: sharedSets.map(({ sharedSet }) => ({
					listId: sharedSet?.id ?? '',
					name: sharedSet?.name ?? '',
					keywords: sharedKeywords.get(sharedSet?.id ?? '') ?? []
				}))
			},
			adGroups: [...groups.values()],
			assets
		};
	}
});

function assetQuery(resource: 'campaign_asset' | 'ad_group_asset', where: string, extra?: string) {
	return `SELECT campaign.id, ${extra ? `${extra}, ` : ''}${resource}.field_type, ${resource}.status, asset.id,
		asset.final_urls, asset.sitelink_asset.link_text, asset.sitelink_asset.description1,
		asset.sitelink_asset.description2, asset.callout_asset.callout_text,
		asset.structured_snippet_asset.header, asset.structured_snippet_asset.values
	FROM ${resource}
	WHERE ${where} AND ${resource}.status != 'REMOVED'
		AND ${resource}.field_type IN ('SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET')
	ORDER BY asset.id`;
}

function emptyAssets(): Assets {
	return { sitelinks: [], callouts: [], structuredSnippets: [] };
}

function addAsset(
	into: Assets,
	{ asset }: GoogleAdsRow,
	link: { fieldType?: string; status?: string } | undefined
) {
	const base = { assetId: asset?.id ?? '', status: link?.status ?? null };
	if (link?.fieldType === 'SITELINK')
		into.sitelinks.push({
			...base,
			linkText: asset?.sitelinkAsset?.linkText ?? null,
			description1: asset?.sitelinkAsset?.description1 ?? null,
			description2: asset?.sitelinkAsset?.description2 ?? null,
			finalUrl: asset?.finalUrls?.[0] ?? null
		});
	else if (link?.fieldType === 'CALLOUT')
		into.callouts.push({ ...base, text: asset?.calloutAsset?.calloutText ?? null });
	else if (link?.fieldType === 'STRUCTURED_SNIPPET')
		into.structuredSnippets.push({
			...base,
			header: asset?.structuredSnippetAsset?.header ?? null,
			values: asset?.structuredSnippetAsset?.values ?? []
		});
}

function toAd({ adGroupAd }: GoogleAdsRow) {
	const ad = adGroupAd?.ad;
	const rsa = ad?.responsiveSearchAd;
	const texts = (list: common.AdTextAsset[] | undefined) =>
		(list ?? []).map(({ text, pinnedField }) => ({
			text: text ?? '',
			pin: pinnedField && PINS.has(pinnedField) ? pinnedField : null
		}));
	return {
		adId: ad?.id ?? '',
		status: adGroupAd?.status ?? null,
		type: ad?.type ?? null,
		adStrength: adGroupAd?.adStrength ?? null,
		headlines: texts(rsa?.headlines),
		descriptions: texts(rsa?.descriptions),
		finalUrls: (ad?.finalUrls ?? []).filter(Boolean),
		path1: rsa?.path1 ?? null,
		path2: rsa?.path2 ?? null
	};
}

function toTerm(keyword: common.KeywordInfo) {
	return { text: keyword.text ?? '', matchType: keyword.matchType ?? 'UNKNOWN' };
}

/** `geoTargetConstants/2784` → `'2784'`. */
function constantId(resourceName: string | undefined) {
	return resourceName?.split('/')[1] || undefined;
}

function minutes(value: common.AdScheduleInfo['startMinute']) {
	return value && value in MINUTES ? MINUTES[value as keyof typeof MINUTES] : 0;
}
