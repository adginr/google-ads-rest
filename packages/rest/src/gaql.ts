/**
 * Helpers for building GAQL (Google Ads Query Language) safely.
 * https://developers.google.com/google-ads/api/docs/query/grammar
 */

/** Escapes a value for a single-quoted GAQL string literal: `o'brien` → `o\'brien`. */
export function escapeGaqlString(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

/** A quoted GAQL string literal. Use for every free-text value placed into a query. */
export function gaqlString(value: string): string {
	return `'${escapeGaqlString(value)}'`;
}

/** `campaign.id`, `metrics.cost_micros`, `ad_group_criterion.keyword.text`. */
export const GAQL_FIELD_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** `campaign`, `ad_group_criterion`. */
export const GAQL_RESOURCE_PATTERN = /^[a-z][a-z0-9_]*$/;

const CLAUSE_KEYWORD = /\b(SELECT|FROM|WHERE|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|PARAMETERS)\b/i;
const COMMENT_OR_TERMINATOR = /;|--|#|\/\*|\*\//;

/**
 * Why a WHERE condition is unsafe to splice into a query, or `undefined` if it is fine.
 * Quoted literals may contain anything; outside them, clause keywords, comments and `;` are rejected
 * so a condition cannot rewrite the rest of the query.
 */
export function unsafeConditionReason(condition: string): string | undefined {
	const { outside, unclosed } = maskQuotedText(condition);
	if (unclosed) return 'has an unclosed quote';
	if (COMMENT_OR_TERMINATOR.test(outside)) return 'contains a comment or statement terminator';
	const keyword = CLAUSE_KEYWORD.exec(outside);
	if (keyword) return `contains the clause keyword ${keyword[1]!.toUpperCase()}`;
	return undefined;
}

/** Replaces quoted spans (with backslash escapes) by spaces. */
function maskQuotedText(value: string): { outside: string; unclosed: boolean } {
	let outside = '';
	let quote: string | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i]!;
		if (quote) {
			if (char === '\\') {
				outside += '  ';
				i++;
			} else {
				if (char === quote) quote = undefined;
				outside += ' ';
			}
		} else if (char === "'" || char === '"') {
			quote = char;
			outside += ' ';
		} else {
			outside += char;
		}
	}
	return { outside, unclosed: quote !== undefined };
}

export interface GaqlQuery {
	fields: string[];
	resource: string;
	conditions?: string[];
	orderings?: string[];
	limit?: number;
	/** Query parameters, e.g. `{ omit_unselected_resource_names: true }`. */
	parameters?: Record<string, string | boolean>;
}

/** Assembles `SELECT … FROM … [WHERE … AND …] [ORDER BY …] [LIMIT n] [PARAMETERS …]`. Does not validate. */
export function buildGaql({
	fields,
	resource,
	conditions,
	orderings,
	limit,
	parameters
}: GaqlQuery): string {
	let query = `SELECT ${fields.join(', ')} FROM ${resource}`;
	if (conditions?.length) query += ` WHERE ${conditions.join(' AND ')}`;
	if (orderings?.length) query += ` ORDER BY ${orderings.join(', ')}`;
	if (limit !== undefined) query += ` LIMIT ${limit}`;
	const params = Object.entries(parameters ?? {});
	if (params.length) query += ` PARAMETERS ${params.map(([k, v]) => `${k}=${v}`).join(', ')}`;
	return query;
}
