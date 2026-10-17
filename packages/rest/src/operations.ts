/**
 * Builders for the mutate operations that make up a Search campaign. They take resource names, so a parent can
 * be an existing entity or a temporary one from a `MutatePlan`, and money in micros like the rest of the client.
 * They do not validate: parse input through the matching tool's schema first, or dry-run with `validateOnly`.
 * Everything that can spend starts PAUSED unless the caller says otherwise.
 */
import { resourceNames } from './resource-names.ts';
import type { common, resources, services } from './types/index.ts';

type Status = 'ENABLED' | 'PAUSED';
type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';

/** The bidding strategies a new Search campaign can start with. */
export type SearchBidding =
	| { strategy: 'MAXIMIZE_CLICKS'; maxCpcBidCeilingMicros?: number }
	| { strategy: 'MAXIMIZE_CONVERSIONS'; targetCpaMicros?: number }
	| { strategy: 'MANUAL_CPC' };

/**
 * Campaign fields for a bidding strategy, plus the update mask that switches an existing campaign to it.
 * The mask names a subfield: Google rejects `manualCpc` alone with FIELD_HAS_SUBFIELDS, and a subfield
 * without a value clears it (no ceiling, no target CPA).
 */
export function biddingFields(bidding: SearchBidding): {
	fields: Partial<resources.Campaign>;
	updateMask: string;
} {
	switch (bidding.strategy) {
		case 'MAXIMIZE_CLICKS':
			return {
				fields: {
					targetSpend: optionalMicros('cpcBidCeilingMicros', bidding.maxCpcBidCeilingMicros)
				},
				updateMask: 'targetSpend.cpcBidCeilingMicros'
			};
		case 'MAXIMIZE_CONVERSIONS':
			return {
				fields: {
					maximizeConversions: optionalMicros('targetCpaMicros', bidding.targetCpaMicros)
				},
				updateMask: 'maximizeConversions.targetCpaMicros'
			};
		case 'MANUAL_CPC':
			return {
				fields: { manualCpc: { enhancedCpcEnabled: false } },
				updateMask: 'manualCpc.enhancedCpcEnabled'
			};
	}
}

export function campaignBudgetOperation(budget: {
	/** Temporary resource name from `MutatePlan.tempResourceName('campaignBudgets')`, if others refer to it. */
	resourceName?: string;
	name: string;
	amountMicros: number;
	/** A shared budget can serve several campaigns; a non-shared one belongs to exactly one. */
	explicitlyShared: boolean;
}): services.MutateOperation {
	return {
		campaignBudgetOperation: {
			create: {
				...(budget.resourceName ? { resourceName: budget.resourceName } : {}),
				name: budget.name,
				amountMicros: String(budget.amountMicros),
				deliveryMethod: 'STANDARD',
				explicitlyShared: budget.explicitlyShared
			}
		}
	};
}

export interface SearchCampaignSpec {
	resourceName?: string;
	name: string;
	/** Campaign budget resource name. */
	budget: string;
	bidding: SearchBidding;
	/** The advertiser's declaration; Google requires it on every new campaign. */
	containsEuPoliticalAdvertising: boolean;
	/** Default PAUSED. */
	status?: Status;
	/** Default false: Google Search only. */
	includeSearchPartners?: boolean;
	/** Default false. */
	includeDisplayNetwork?: boolean;
	/** `YYYY-MM-DD` in the account time zone; default today. */
	startDate?: string;
	/** `YYYY-MM-DD`, inclusive; default none (runs until paused). */
	endDate?: string;
	/**
	 * PRESENCE (default): people in the targeted locations. PRESENCE_OR_INTEREST also reaches people searching
	 * about them from elsewhere. Exclusions always use presence.
	 */
	locationTargeting?: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
}

export function searchCampaignOperation(spec: SearchCampaignSpec): services.MutateOperation {
	const includeSearchPartners = spec.includeSearchPartners ?? false;
	return {
		campaignOperation: {
			create: {
				...(spec.resourceName ? { resourceName: spec.resourceName } : {}),
				name: spec.name,
				advertisingChannelType: 'SEARCH',
				status: spec.status ?? 'PAUSED',
				campaignBudget: spec.budget,
				...biddingFields(spec.bidding).fields,
				networkSettings: {
					targetGoogleSearch: true,
					targetSearchNetwork: includeSearchPartners,
					targetPartnerSearchNetwork: false,
					targetContentNetwork: spec.includeDisplayNetwork ?? false
				},
				geoTargetTypeSetting: {
					positiveGeoTargetType: spec.locationTargeting ?? 'PRESENCE',
					negativeGeoTargetType: 'PRESENCE'
				},
				containsEuPoliticalAdvertising: spec.containsEuPoliticalAdvertising
					? 'CONTAINS_EU_POLITICAL_ADVERTISING'
					: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
				...(spec.startDate ? { startDateTime: `${spec.startDate} 00:00:00` } : {}),
				...(spec.endDate ? { endDateTime: `${spec.endDate} 23:59:59` } : {})
			}
		}
	};
}

/** Location targets and exclusions and language targets of a campaign, one operation each. */
export function campaignTargetingOperations(
	campaign: string,
	targeting: { locationIds?: number[]; excludedLocationIds?: number[]; languageIds?: number[] }
): services.MutateOperation[] {
	const create = (criterion: Partial<resources.CampaignCriterion>): services.MutateOperation => ({
		campaignCriterionOperation: { create: { campaign, ...criterion } }
	});
	return [
		...(targeting.locationIds ?? []).map((id) =>
			create({ location: { geoTargetConstant: resourceNames.geoTargetConstant(id) } })
		),
		...(targeting.excludedLocationIds ?? []).map((id) =>
			create({
				negative: true,
				location: { geoTargetConstant: resourceNames.geoTargetConstant(id) }
			})
		),
		...(targeting.languageIds ?? []).map((id) =>
			create({ language: { languageConstant: resourceNames.languageConstant(id) } })
		)
	];
}

export function adGroupOperation(adGroup: {
	resourceName?: string;
	/** Campaign resource name. */
	campaign: string;
	name: string;
	/** Default PAUSED. */
	status?: Status;
	type?: 'SEARCH_STANDARD' | 'DISPLAY_STANDARD' | 'SEARCH_DYNAMIC_ADS';
	cpcBidMicros?: number;
}): services.MutateOperation {
	return {
		adGroupOperation: {
			create: {
				...(adGroup.resourceName ? { resourceName: adGroup.resourceName } : {}),
				name: adGroup.name,
				campaign: adGroup.campaign,
				status: adGroup.status ?? 'PAUSED',
				type: adGroup.type ?? 'SEARCH_STANDARD',
				...(adGroup.cpcBidMicros === undefined
					? {}
					: { cpcBidMicros: String(adGroup.cpcBidMicros) })
			}
		}
	};
}

/** A positive keyword. It serves only once its ad group and campaign are enabled. */
export function keywordOperation(keyword: {
	/** Ad group resource name. */
	adGroup: string;
	text: string;
	matchType: MatchType;
	/** Default ENABLED. */
	status?: Status;
	cpcBidMicros?: number;
}): services.MutateOperation {
	return {
		adGroupCriterionOperation: {
			create: {
				adGroup: keyword.adGroup,
				status: keyword.status ?? 'ENABLED',
				keyword: { text: keyword.text, matchType: keyword.matchType },
				...(keyword.cpcBidMicros === undefined
					? {}
					: { cpcBidMicros: String(keyword.cpcBidMicros) })
			}
		}
	};
}

/** A negative keyword on an ad group (`adGroup`) or a campaign (`campaign`). */
export function negativeKeywordOperation(
	negative: ({ adGroup: string } | { campaign: string }) & { text: string; matchType: MatchType }
): services.MutateOperation {
	const keyword = { text: negative.text, matchType: negative.matchType };
	return 'adGroup' in negative
		? {
				adGroupCriterionOperation: {
					create: { adGroup: negative.adGroup, negative: true, keyword }
				}
			}
		: {
				campaignCriterionOperation: {
					create: { campaign: negative.campaign, negative: true, keyword }
				}
			};
}

export type Pinned<Position extends string> = string | { text: string; pinnedField?: Position };

export function responsiveSearchAdOperation(ad: {
	/** Ad group resource name. */
	adGroup: string;
	headlines: Array<Pinned<'HEADLINE_1' | 'HEADLINE_2' | 'HEADLINE_3'>>;
	descriptions: Array<Pinned<'DESCRIPTION_1' | 'DESCRIPTION_2'>>;
	finalUrls: string[];
	path1?: string;
	path2?: string;
	/** Default PAUSED. */
	status?: Status;
}): services.MutateOperation {
	const assets = (texts: Array<Pinned<string>>) =>
		texts.map((asset): common.AdTextAsset => {
			if (typeof asset === 'string') return { text: asset };
			return asset.pinnedField
				? { text: asset.text, pinnedField: asset.pinnedField as common.AdTextAsset['pinnedField'] }
				: { text: asset.text };
		});
	return {
		adGroupAdOperation: {
			create: {
				adGroup: ad.adGroup,
				status: ad.status ?? 'PAUSED',
				ad: {
					finalUrls: ad.finalUrls,
					responsiveSearchAd: {
						headlines: assets(ad.headlines),
						descriptions: assets(ad.descriptions),
						...(ad.path1 ? { path1: ad.path1 } : {}),
						...(ad.path2 ? { path2: ad.path2 } : {})
					}
				}
			}
		}
	};
}

/** A shared negative keyword list; attach it to campaigns with `campaignSharedSetOperation`. */
export function negativeKeywordListOperation(list: {
	resourceName?: string;
	name: string;
}): services.MutateOperation {
	return {
		sharedSetOperation: {
			create: {
				...(list.resourceName ? { resourceName: list.resourceName } : {}),
				name: list.name,
				type: 'NEGATIVE_KEYWORDS'
			}
		}
	};
}

/** A keyword in a shared negative keyword list. */
export function sharedNegativeKeywordOperation(keyword: {
	/** Shared set resource name. */
	sharedSet: string;
	text: string;
	matchType: MatchType;
}): services.MutateOperation {
	return {
		sharedCriterionOperation: {
			create: {
				sharedSet: keyword.sharedSet,
				keyword: { text: keyword.text, matchType: keyword.matchType }
			}
		}
	};
}

/** Attaches a shared set (such as a negative keyword list) to a campaign. */
export function campaignSharedSetOperation(link: {
	campaign: string;
	sharedSet: string;
}): services.MutateOperation {
	return { campaignSharedSetOperation: { create: link } };
}

function optionalMicros<Key extends string>(key: Key, micros: number | undefined) {
	return (micros === undefined ? {} : { [key]: String(micros) }) as Partial<Record<Key, string>>;
}
