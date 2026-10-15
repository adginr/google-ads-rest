import type { GoogleAdsClient } from '@adginr/google-ads-rest';
import { adsTools, type AdsTool } from '@adginr/google-ads-rest/tools';
import { McpServer } from '@modelcontextprotocol/server';
import pkg from '../package.json' with { type: 'json' };
import { registerDocResources } from './resources.ts';

export interface GoogleAdsMcpServerOptions {
	ads: GoogleAdsClient;
	/** Register only tools that never change the account. */
	readOnly?: boolean;
	/** Override the tool set, e.g. a subset of `adsTools` or your own `defineTool()` tools. */
	tools?: AdsTool[];
}

const INSTRUCTIONS = `Google Ads account tools over the REST API.
Start with list_accessible_customers (or list_campaigns when you know the customer ID).
Before the search tool, look fields up with get_resource_metadata instead of guessing them.
Mutating tools support validateOnly for a dry run; new campaigns' ad groups and ads start PAUSED.
Prefer pausing over removing: removals are permanent.`;

/** Builds an MCP server exposing Google Ads tools and API documentation resources. */
export function createGoogleAdsMcpServer({
	ads,
	readOnly = false,
	tools = adsTools
}: GoogleAdsMcpServerOptions): McpServer {
	const server = new McpServer(
		{ name: 'google-ads', title: 'Google Ads', version: pkg.version },
		{ instructions: INSTRUCTIONS }
	);

	for (const tool of tools) {
		if (readOnly && !tool.annotations.readOnly) continue;
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.input,
				outputSchema: tool.output,
				annotations: {
					title: tool.title,
					readOnlyHint: tool.annotations.readOnly,
					destructiveHint: tool.annotations.destructive ?? !tool.annotations.readOnly,
					idempotentHint: tool.annotations.idempotent ?? false,
					openWorldHint: true
				}
			},
			async (input) => {
				// Thrown errors become `isError: true` results the model can read and recover from.
				const output = await tool.run(input, { ads });
				return {
					content: [{ type: 'text', text: JSON.stringify(output) }],
					structuredContent: output
				};
			}
		);
	}

	registerDocResources(server);
	return server;
}
