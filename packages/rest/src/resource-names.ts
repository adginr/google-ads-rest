/**
 * Resource name builders and parsers. Google Ads identifies entities by resource names such as
 * `customers/1234567890/adGroupCriteria/111~222`; composite IDs are joined with `~`.
 */

export const resourceNames = {
	customer: (customerId: string) => `customers/${customerId}`,
	campaign: (customerId: string, campaignId: string) =>
		`customers/${customerId}/campaigns/${campaignId}`,
	campaignBudget: (customerId: string, budgetId: string) =>
		`customers/${customerId}/campaignBudgets/${budgetId}`,
	adGroup: (customerId: string, adGroupId: string) =>
		`customers/${customerId}/adGroups/${adGroupId}`,
	adGroupAd: (customerId: string, adGroupId: string, adId: string) =>
		`customers/${customerId}/adGroupAds/${adGroupId}~${adId}`,
	adGroupCriterion: (customerId: string, adGroupId: string, criterionId: string) =>
		`customers/${customerId}/adGroupCriteria/${adGroupId}~${criterionId}`,
	asset: (customerId: string, assetId: string) => `customers/${customerId}/assets/${assetId}`,
	geoTargetConstant: (id: number | string) => `geoTargetConstants/${id}`,
	languageConstant: (id: number | string) => `languageConstants/${id}`
};

/**
 * The entity's own ID from a resource name: the segment after `/{collection}/`, and for composite IDs
 * the last `~` part. `idFromResourceName('customers/1/adGroupCriteria/111~222', 'adGroupCriteria')` → `'222'`.
 */
export function idFromResourceName(
	resourceName: string | undefined,
	collection: string
): string | undefined {
	if (!resourceName) return undefined;
	const marker = `/${collection}/`;
	const start = resourceName.lastIndexOf(marker);
	if (start === -1) return undefined;
	const segment = resourceName.slice(start + marker.length).split('/')[0]!;
	return segment.split('~').at(-1) || undefined;
}

/** All `~`-separated parts of the last path segment: `campaignAssets/12~34~CALLOUT` → `['12', '34', 'CALLOUT']`. */
export function compositeIdParts(resourceName: string): string[] {
	return (resourceName.split('/').at(-1) ?? '').split('~');
}
