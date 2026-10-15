import { z } from 'zod';
import { idFromResourceName, resourceNames } from '../resource-names.ts';
import { defineTool } from './define-tool.ts';
import { customerId, entityId, money, text, upperEnum, validateOnly } from './schemas.ts';

export const createAdGroup = defineTool({
	name: 'create_ad_group',
	title: 'Create ad group',
	description:
		'Creates an ad group in an existing campaign, PAUSED by default so a half-built ad group cannot spend. ' +
		'Typical flow: create it, add keywords (add_keywords_to_ad_group) and an ad (create_responsive_search_ad), ' +
		'then enable it with update_ad_group_status. A dry run returns no ID, so to dry-run the next steps create ' +
		'the ad group for real (it cannot spend while paused) and dry-run against the returned ID.',
	input: z.object({
		customerId,
		campaignId: entityId(
			'Campaign that will contain the ad group. Its channel must match the type.'
		),
		name: text(255, 'Ad group name, unique within the campaign, at most 255 characters.'),
		status: upperEnum(['ENABLED', 'PAUSED'] as const)
			.default('PAUSED')
			.describe('PAUSED by default; enable once the ad group has keywords and ads.'),
		type: upperEnum(['SEARCH_STANDARD', 'DISPLAY_STANDARD', 'SEARCH_DYNAMIC_ADS'] as const).default(
			'SEARCH_STANDARD'
		),
		cpcBid: money(
			'Optional default max CPC bid; omit to use the campaign bidding strategy (needed for manual CPC).'
		).optional(),
		validateOnly
	}),
	output: z.object({
		adGroup: z.string().nullable().describe('Resource name; null for a dry run.'),
		adGroupId: z.string().nullable(),
		campaignId: z.string(),
		name: z.string(),
		status: z.string(),
		type: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: false, idempotent: false },
	async run({ customerId, campaignId, name, status, type, cpcBid, validateOnly }, { ads }) {
		const [result] = await ads.mutate(
			customerId,
			[
				{
					adGroupOperation: {
						create: {
							name,
							campaign: resourceNames.campaign(customerId, campaignId),
							status,
							type,
							...(cpcBid === undefined ? {} : { cpcBidMicros: String(cpcBid) })
						}
					}
				}
			],
			{ validateOnly }
		);
		const adGroup = result?.adGroupResult?.resourceName ?? null;
		return {
			adGroup,
			adGroupId: idFromResourceName(adGroup ?? undefined, 'adGroups') ?? null,
			campaignId,
			name,
			status,
			type,
			validateOnly
		};
	}
});

export const updateAdGroupStatus = defineTool({
	name: 'update_ad_group_status',
	title: 'Update ad group status',
	description:
		'Sets an ad group to ENABLED, PAUSED or REMOVED. REMOVED is permanent (it cannot be re-enabled), so prefer ' +
		'PAUSED unless the user explicitly asked to delete it. An ENABLED ad group still does not serve while its ' +
		'campaign is paused.',
	input: z.object({
		customerId,
		adGroupId: entityId('Ad group ID, digits only.'),
		status: upperEnum(['ENABLED', 'PAUSED', 'REMOVED'] as const).describe(
			'No default on purpose: each value affects spend differently.'
		),
		validateOnly
	}),
	output: z.object({
		adGroup: z.string().nullable().describe('Resource name; null for a dry run.'),
		adGroupId: z.string(),
		status: z.string(),
		validateOnly: z.boolean()
	}),
	annotations: { readOnly: false, destructive: true, idempotent: true },
	async run({ customerId, adGroupId, status, validateOnly }, { ads }) {
		const resourceName = resourceNames.adGroup(customerId, adGroupId);
		// REMOVED is not a settable status in an update; removal is its own operation.
		const [result] = await ads.mutate(
			customerId,
			[
				{
					adGroupOperation:
						status === 'REMOVED'
							? { remove: resourceName }
							: { update: { resourceName, status }, updateMask: 'status' }
				}
			],
			{ validateOnly }
		);
		return {
			adGroup: result?.adGroupResult?.resourceName ?? null,
			adGroupId,
			status,
			validateOnly
		};
	}
});
