import { GOOGLE_ADS_API_VERSION } from '@adginr/google-ads-rest';
import type { McpServer } from '@modelcontextprotocol/server';

/** Google Ads API reference pages, fetched live when a client reads them. */
const DOCS = [
	{
		name: 'release-notes',
		uri: 'google-ads://docs/release-notes',
		url: 'https://developers.google.com/google-ads/api/docs/release-notes',
		mimeType: 'text/html',
		description:
			'Google Ads API release notes: check for breaking changes and when features became available.'
	},
	{
		name: 'metrics',
		uri: 'google-ads://docs/metrics',
		url: 'https://developers.google.com/google-ads/api/fields/latest/metrics',
		mimeType: 'text/html',
		description: 'Every GAQL metric with its type and meaning.'
	},
	{
		name: 'segments',
		uri: 'google-ads://docs/segments',
		url: 'https://developers.google.com/google-ads/api/fields/latest/segments',
		mimeType: 'text/html',
		description: 'Every GAQL segment: how metrics can be broken down (date, device, network, ...).'
	},
	{
		name: 'discovery-document',
		uri: 'google-ads://docs/discovery-document',
		url: `https://googleads.googleapis.com/$discovery/rest?version=${GOOGLE_ADS_API_VERSION}`,
		mimeType: 'application/json',
		description: `REST discovery document of Google Ads API ${GOOGLE_ADS_API_VERSION}: every resource, field and enum (large, about 3 MB).`
	}
] as const;

export function registerDocResources(server: McpServer): void {
	for (const doc of DOCS) {
		server.registerResource(
			doc.name,
			doc.uri,
			{ title: doc.name, description: doc.description, mimeType: doc.mimeType },
			async (uri) => {
				const res = await fetch(doc.url);
				if (!res.ok) throw new Error(`GET ${doc.url} failed: ${res.status} ${res.statusText}`);
				return { contents: [{ uri: uri.href, mimeType: doc.mimeType, text: await res.text() }] };
			}
		);
	}
}
