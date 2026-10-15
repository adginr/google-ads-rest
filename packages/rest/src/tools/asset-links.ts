/**
 * Shared plumbing for asset extensions (callouts, sitelinks): assets are immutable, reusable objects that serve
 * only when linked to the account (CustomerAsset), a campaign (CampaignAsset) or an ad group (AdGroupAsset).
 */
import { z } from 'zod';
import type { GoogleAdsClient, GoogleAdsRow } from '../client.ts';
import { buildGaql } from '../gaql.ts';
import { compositeIdParts, resourceNames } from '../resource-names.ts';
import type { services } from '../types/index.ts';
import { entityId, upperEnum } from './schemas.ts';

export type LinkLevel = 'ACCOUNT' | 'CAMPAIGN' | 'AD_GROUP';
export type AssetFieldType = 'CALLOUT' | 'SITELINK';

const LEVELS = {
	ACCOUNT: { resource: 'customer_asset', row: 'customerAsset', collection: 'customerAssets' },
	CAMPAIGN: { resource: 'campaign_asset', row: 'campaignAsset', collection: 'campaignAssets' },
	AD_GROUP: { resource: 'ad_group_asset', row: 'adGroupAsset', collection: 'adGroupAssets' }
} as const;

/** Asset ID (`123`) or asset resource name (`customers/1/assets/123`). */
export const assetRef = z
	.string()
	.trim()
	.regex(
		/^(customers\/\d+\/assets\/)?\d+$/,
		"must be an asset ID ('123') or 'customers/<id>/assets/<id>'."
	);

export const linkStatus = upperEnum(['ENABLED', 'PAUSED'] as const).describe('New link status.');

/** Link resource names of one level, e.g. `customers/1/campaignAssets/2~3~CALLOUT`. */
export function linkResourceNamesFor(
	level: LinkLevel,
	customerId: string,
	names: string[]
): string[] {
	const prefix = `customers/${customerId}/${LEVELS[level].collection}/`;
	const wrong = names.find((name) => !name.startsWith(prefix));
	if (wrong) {
		throw new Error(
			`'${wrong}' is not a ${level} link of customer ${customerId}; expected '${prefix}…'. Get link names from the list tool.`
		);
	}
	return names;
}

export function attachOperations(
	level: LinkLevel,
	customerId: string,
	targetId: string | undefined,
	assets: string[],
	fieldType: AssetFieldType
): services.MutateOperation[] {
	return assets.map((ref) => {
		const asset = ref.includes('/') ? ref : resourceNames.asset(customerId, ref);
		const link = { asset, fieldType, status: 'ENABLED' as const };
		if (level === 'ACCOUNT') return { customerAssetOperation: { create: link } };
		if (level === 'CAMPAIGN')
			return {
				campaignAssetOperation: {
					create: { ...link, campaign: resourceNames.campaign(customerId, targetId!) }
				}
			};
		return {
			adGroupAssetOperation: {
				create: { ...link, adGroup: resourceNames.adGroup(customerId, targetId!) }
			}
		};
	});
}

export function statusOperations(
	level: LinkLevel,
	names: string[],
	status: 'ENABLED' | 'PAUSED'
): services.MutateOperation[] {
	return names.map((resourceName) => {
		const op = { update: { resourceName, status }, updateMask: 'status' };
		if (level === 'ACCOUNT') return { customerAssetOperation: op };
		if (level === 'CAMPAIGN') return { campaignAssetOperation: op };
		return { adGroupAssetOperation: op };
	});
}

export function removeOperations(level: LinkLevel, names: string[]): services.MutateOperation[] {
	return names.map((remove) => {
		if (level === 'ACCOUNT') return { customerAssetOperation: { remove } };
		if (level === 'CAMPAIGN') return { campaignAssetOperation: { remove } };
		return { adGroupAssetOperation: { remove } };
	});
}

export function linkResultName(
	level: LinkLevel,
	result: services.MutateOperationResponse | undefined
): string | null {
	const named =
		level === 'ACCOUNT'
			? result?.customerAssetResult
			: level === 'CAMPAIGN'
				? result?.campaignAssetResult
				: result?.adGroupAssetResult;
	return named?.resourceName ?? null;
}

/** IDs encoded in a link name: `campaignAssets/{campaignId}~{assetId}~{fieldType}` and friends. */
export function parseLink(level: LinkLevel, customerId: string, linkName: string) {
	const parts = compositeIdParts(linkName);
	const [owner, assetId] = level === 'ACCOUNT' ? [undefined, parts[0]] : [parts[0], parts[1]];
	return {
		asset: assetId ? resourceNames.asset(customerId, assetId) : null,
		assetId: assetId ?? null,
		campaignId: level === 'CAMPAIGN' ? (owner ?? null) : null,
		adGroupId: level === 'AD_GROUP' ? (owner ?? null) : null
	};
}

/** Link plus owning campaign / ad group, as returned by the list tools. */
export const linkFields = {
	link: z.string().describe('Link resource name, used by the update-status and remove tools.'),
	level: z.string(),
	status: z.string().nullable(),
	primaryStatus: z
		.string()
		.nullable()
		.describe('Serving status, e.g. ELIGIBLE, LIMITED, NOT_ELIGIBLE.'),
	asset: z.string().nullable(),
	assetId: z.string().nullable(),
	campaignId: z.string().nullable(),
	campaignName: z.string().nullable(),
	adGroupId: z.string().nullable(),
	adGroupName: z.string().nullable()
};

export async function listLinks(
	ads: GoogleAdsClient,
	{
		customerId,
		level,
		fieldType,
		assetFields,
		campaignId,
		adGroupId,
		includeRemoved,
		limit
	}: {
		customerId: string;
		level: LinkLevel;
		fieldType: AssetFieldType;
		assetFields: string[];
		campaignId?: string;
		adGroupId?: string;
		includeRemoved: boolean;
		limit: number;
	}
): Promise<Array<{ row: GoogleAdsRow; link: z.infer<z.ZodObject<typeof linkFields>> }>> {
	const { resource, row: rowKey } = LEVELS[level];
	const fields = [
		`${resource}.resource_name`,
		`${resource}.asset`,
		`${resource}.status`,
		`${resource}.primary_status`,
		...(level === 'ACCOUNT' ? [] : ['campaign.id', 'campaign.name']),
		...(level === 'AD_GROUP' ? ['ad_group.id', 'ad_group.name'] : []),
		'asset.resource_name',
		'asset.id',
		...assetFields
	];
	const conditions = [`${resource}.field_type = '${fieldType}'`];
	if (campaignId && level !== 'ACCOUNT') conditions.push(`campaign.id = ${campaignId}`);
	if (adGroupId && level === 'AD_GROUP') conditions.push(`ad_group.id = ${adGroupId}`);
	if (!includeRemoved) conditions.push(`${resource}.status != 'REMOVED'`);

	const rows = await ads.search(customerId, buildGaql({ fields, resource, conditions, limit }), {
		maxRows: limit
	});
	return rows.map((row) => {
		const link = row[rowKey] as
			| { resourceName?: string; asset?: string; status?: string; primaryStatus?: string }
			| undefined;
		const parsed = parseLink(level, customerId, link?.resourceName ?? '');
		return {
			row,
			link: {
				link: link?.resourceName ?? '',
				level,
				status: link?.status ?? null,
				primaryStatus: link?.primaryStatus ?? null,
				asset: row.asset?.resourceName ?? link?.asset ?? parsed.asset,
				assetId: row.asset?.id ?? parsed.assetId,
				campaignId: row.campaign?.id ?? parsed.campaignId,
				campaignName: row.campaign?.name ?? null,
				adGroupId: row.adGroup?.id ?? parsed.adGroupId,
				adGroupName: row.adGroup?.name ?? null
			}
		};
	});
}

/** Common inputs of the list tools. */
export const listInputs = {
	includeRemoved: z.boolean().default(false).describe('Also return removed links.'),
	limit: z.number().int().positive().max(10_000).default(1000)
};

export const optionalCampaignFilter = entityId('Only links of this campaign.').optional();
