/**
 * Agent tools for Google Ads: zod-typed, model-facing descriptions, safe defaults (new things start PAUSED,
 * every mutation supports `validateOnly`, removals are marked destructive). Framework-agnostic: wire them into
 * MCP (`@adginr/google-ads-mcp`), TanStack AI, the Vercel AI SDK, or call `tool.run(input, { ads })` directly.
 */
import { listAccessibleCustomers, listCampaigns } from './accounts.ts';
import { createAdGroup, updateAdGroupStatus } from './ad-groups.ts';
import { createResponsiveSearchAd, listAdsInAdGroup, updateAdStatus } from './ads.ts';
import {
	attachCalloutsToAccount,
	attachCalloutsToCampaign,
	createCallouts,
	listCallouts,
	removeCalloutLinks,
	updateCalloutLinkStatus
} from './callouts.ts';
import { enableCampaign, pauseCampaign, updateCampaignBudget } from './campaigns.ts';
import type { AdsTool } from './define-tool.ts';
import { generateKeywordIdeas } from './keyword-planner.ts';
import {
	addKeywordsToAdGroup,
	addNegativeKeywordToAdGroup,
	addNegativeKeywordToCampaign,
	removeKeywordFromAdGroup,
	removeNegativeKeywordFromCampaign
} from './keywords.ts';
import { getResourceMetadata, search } from './search.ts';
import {
	attachSitelinksToAdGroup,
	attachSitelinksToCampaign,
	createSitelinks,
	listSitelinks,
	removeSitelinkLinks,
	updateSitelinkLinkStatus
} from './sitelinks.ts';

export { defineTool, type AdsTool, type ToolContext } from './define-tool.ts';
export * as schemas from './schemas.ts';

/** Every tool, in the order an agent typically needs them. */
export const adsTools = [
	// Discover
	listAccessibleCustomers,
	listCampaigns,
	getResourceMetadata,
	search,
	generateKeywordIdeas,
	// Campaigns
	pauseCampaign,
	enableCampaign,
	updateCampaignBudget,
	// Ad groups and keywords
	createAdGroup,
	updateAdGroupStatus,
	addKeywordsToAdGroup,
	removeKeywordFromAdGroup,
	addNegativeKeywordToAdGroup,
	addNegativeKeywordToCampaign,
	removeNegativeKeywordFromCampaign,
	// Ads
	listAdsInAdGroup,
	createResponsiveSearchAd,
	updateAdStatus,
	// Callouts
	listCallouts,
	createCallouts,
	attachCalloutsToCampaign,
	attachCalloutsToAccount,
	updateCalloutLinkStatus,
	removeCalloutLinks,
	// Sitelinks
	listSitelinks,
	createSitelinks,
	attachSitelinksToCampaign,
	attachSitelinksToAdGroup,
	updateSitelinkLinkStatus,
	removeSitelinkLinks
] as unknown as AdsTool[];

/** Only the tools that never change anything. */
export const readOnlyAdsTools = adsTools.filter((tool) => tool.annotations.readOnly);

export {
	addKeywordsToAdGroup,
	addNegativeKeywordToAdGroup,
	addNegativeKeywordToCampaign,
	attachCalloutsToAccount,
	attachCalloutsToCampaign,
	attachSitelinksToAdGroup,
	attachSitelinksToCampaign,
	createAdGroup,
	createCallouts,
	createResponsiveSearchAd,
	createSitelinks,
	enableCampaign,
	generateKeywordIdeas,
	getResourceMetadata,
	listAccessibleCustomers,
	listAdsInAdGroup,
	listCallouts,
	listCampaigns,
	listSitelinks,
	pauseCampaign,
	removeCalloutLinks,
	removeKeywordFromAdGroup,
	removeNegativeKeywordFromCampaign,
	removeSitelinkLinks,
	search,
	updateAdGroupStatus,
	updateAdStatus,
	updateCalloutLinkStatus,
	updateCampaignBudget,
	updateSitelinkLinkStatus
};
