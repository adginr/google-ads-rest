import { z } from 'zod';
import {
	buildGaql,
	GAQL_FIELD_PATTERN,
	GAQL_RESOURCE_PATTERN,
	gaqlString,
	unsafeConditionReason
} from '../gaql.ts';
import { GAQL_RESOURCES } from '../gaql-resources.gen.ts';
import { defineTool } from './define-tool.ts';
import { customerId } from './schemas.ts';

const field = z
	.string()
	.trim()
	.regex(GAQL_FIELD_PATTERN, "must be a full field name such as 'campaign.id'.");

const ordering = z
	.string()
	.trim()
	.transform((value, ctx) => {
		const [name, direction, ...extra] = value.split(/\s+/);
		const dir = direction?.toUpperCase();
		if (
			!name ||
			!GAQL_FIELD_PATTERN.test(name) ||
			extra.length ||
			(dir && dir !== 'ASC' && dir !== 'DESC')
		) {
			ctx.addIssue({
				code: 'custom',
				message: `ordering '${value}' must be '<field> [ASC|DESC]'.`
			});
			return z.NEVER;
		}
		return dir ? `${name} ${dir}` : name;
	});

const condition = z
	.string()
	.trim()
	.min(1)
	.superRefine((value, ctx) => {
		const reason = unsafeConditionReason(value);
		if (reason) ctx.addIssue({ code: 'custom', message: `condition '${value}' ${reason}.` });
	});

/** `ad_group_criterion.keyword.text` → `['adGroupCriterion', 'keyword', 'text']`. */
const camelPath = (path: string) =>
	path.split('.').map((part) => part.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()));

function pick(row: unknown, path: string): unknown {
	let value = row;
	for (const key of camelPath(path)) {
		if (value === null || typeof value !== 'object') return null;
		value = (value as Record<string, unknown>)[key];
	}
	return value ?? null;
}

export const search = defineTool({
	name: 'search',
	title: 'Search with GAQL',
	description: `Fetches data from one Google Ads account with a structured GAQL query (read-only).
Builds SELECT <fields> FROM <resource> [WHERE <conditions joined by AND>] [ORDER BY <orderings>] [LIMIT <limit>].
Returns one object per row keyed by the requested field names. Values are as the REST API sends them:
int64 values (IDs, metrics, *_micros) as strings, money in micros (divide by 1,000,000), enums as names,
and null where the API omitted the value (for metrics that means 0).

Fields: do not guess them. Call get_resource_metadata for the resource first; always use full names
('campaign.id', not 'id'). No wildcards.
Dates: use 'YYYY-MM-DD' literals with an explicit start and end, e.g.
"segments.date BETWEEN '2026-01-01' AND '2026-01-31'". Never use date-range literals such as LAST_30_DAYS.
change_event: requires a limit of at most 10000 and a finite date range on change_event.change_date_time.
Conversions: upload problems show up in offline_conversion_upload_conversion_action_summary.
Grammar: https://developers.google.com/google-ads/api/docs/query/grammar

Valid resources: ${GAQL_RESOURCES.join(', ')}.`,
	input: z.object({
		customerId,
		resource: z
			.string()
			.trim()
			.regex(GAQL_RESOURCE_PATTERN, "must be a resource name such as 'campaign' or 'ad_group'.")
			.describe(
				'The resource after FROM, e.g. campaign, ad_group, keyword_view, search_term_view.'
			),
		fields: z
			.array(field)
			.min(1)
			.describe('Fields to SELECT, e.g. ["campaign.id", "metrics.clicks"].'),
		conditions: z
			.array(condition)
			.optional()
			.describe(
				`WHERE conditions combined with AND, e.g. ["campaign.status = 'ENABLED'", "metrics.clicks > 10"]. ` +
					'Quote string values with single quotes.'
			),
		orderings: z
			.array(ordering)
			.optional()
			.describe('ORDER BY entries, e.g. ["metrics.cost_micros DESC"].'),
		limit: z.number().int().positive().max(10_000).optional().describe('Maximum rows to return.')
	}),
	output: z.object({
		rows: z.array(z.record(z.string(), z.unknown())),
		rowCount: z.number(),
		query: z.string().describe('The GAQL query that was run.')
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ customerId, resource, fields, conditions, orderings, limit }, { ads }) {
		if (resource === 'change_event' && limit === undefined) {
			throw new Error('Queries on change_event need a limit of at most 10000.');
		}
		const query = buildGaql({
			fields,
			resource,
			conditions,
			orderings,
			limit,
			parameters: { omit_unselected_resource_names: true }
		});
		const rows = await ads.search(customerId, query, { maxRows: limit ?? 10_000 });
		return {
			rows: rows.map((row) => Object.fromEntries(fields.map((path) => [path, pick(row, path)]))),
			rowCount: rows.length,
			query
		};
	}
});

export const getResourceMetadata = defineTool({
	name: 'get_resource_metadata',
	title: 'Get resource fields',
	description:
		'Lists the fields of one GAQL resource (e.g. campaign, ad_group) that can be selected, filtered and ' +
		'sorted, plus the related resources, segments and metrics that can be selected with it. ' +
		'Call it before the search tool instead of guessing field names. The result rarely changes: reuse it.',
	input: z.object({
		resource: z
			.string()
			.trim()
			.regex(GAQL_RESOURCE_PATTERN, "must be a resource name such as 'campaign'.")
			.describe('GAQL resource name, e.g. campaign, ad_group_criterion.')
	}),
	output: z.object({
		resource: z.string(),
		selectable: z.array(z.string()),
		filterable: z.array(z.string()),
		sortable: z.array(z.string()),
		attributedResources: z
			.array(z.string())
			.describe('Other resources whose fields can be selected alongside this one.'),
		segments: z.array(z.string()).describe('Segments that can be selected with this resource.'),
		metrics: z.array(z.string()).describe('Metrics that can be selected with this resource.')
	}),
	annotations: { readOnly: true, idempotent: true },
	async run({ resource }, { ads }) {
		const [own, [meta]] = await Promise.all([
			ads.searchFields(
				`SELECT name, selectable, filterable, sortable WHERE name LIKE ${gaqlString(`${resource}.%`)}`
			),
			ads.searchFields(
				`SELECT name, attribute_resources, segments, metrics WHERE name = ${gaqlString(resource)}`
			)
		]);
		if (!own.length && !meta) {
			throw new Error(
				`Unknown GAQL resource '${resource}'. See the resource list in the search tool.`
			);
		}
		const names = (predicate: (f: (typeof own)[number]) => boolean | undefined) =>
			own
				.filter(predicate)
				.map((f) => f.name!)
				.sort();
		return {
			resource,
			selectable: names((f) => f.selectable),
			filterable: names((f) => f.filterable),
			sortable: names((f) => f.sortable),
			attributedResources: meta?.attributeResources ?? [],
			segments: meta?.segments ?? [],
			metrics: meta?.metrics ?? []
		};
	}
});
