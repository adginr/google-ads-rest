/**
 * Shared zod schemas for tool inputs. Models send imperfect input, so schemas normalize what is safe to
 * normalize (dashes in customer IDs, enum case, surrounding whitespace) and reject everything else with a
 * message the model can act on. Booleans are never coerced: the string "false" is truthy and would turn a
 * dry run into a real change.
 */
import { z } from 'zod';

/** Google Ads shows IDs as `123-456-7890`; the API wants the 10 digits only. */
export const customerId = z
	.string()
	.trim()
	.regex(/^\d{3}-?\d{3}-?\d{4}$/, 'customerId must be 10 digits, dashes optional (123-456-7890).')
	.transform((id) => id.replaceAll('-', ''))
	.describe('Google Ads customer ID, 10 digits, dashes optional (e.g. 123-456-7890).');

/** A numeric entity ID (campaign, ad group, criterion, ad, asset) as a string of digits. */
export function entityId(description: string) {
	return z.string().trim().regex(/^\d+$/, 'IDs contain digits only.').describe(description);
}

/** Enum that accepts any case and surrounding whitespace (`' paused '` → `'PAUSED'`). */
export function upperEnum<const T extends readonly [string, ...string[]]>(values: T) {
	return z.preprocess(
		(value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
		z.enum(values)
	);
}

/** Number of Unicode code points, matching how Google Ads counts characters. */
export const charCount = (value: string) => [...value].length;

/** Required trimmed text with a maximum length in characters. */
export function text(maxLength: number | undefined, description: string) {
	const schema = z.string().trim().min(1, 'cannot be empty.');
	return (
		maxLength === undefined
			? schema
			: schema.refine((value) => charCount(value) <= maxLength, {
					error: (issue) =>
						`must be ${maxLength} characters or fewer: '${issue.input}' is ${charCount(String(issue.input))} characters.`
				})
	).describe(description);
}

/** Optional text; blank becomes `undefined`. */
export function optionalText(maxLength: number | undefined, description: string) {
	return z
		.string()
		.trim()
		.refine((value) => maxLength === undefined || charCount(value) <= maxLength, {
			error: (issue) =>
				`must be ${maxLength} characters or fewer: '${issue.input}' is ${charCount(String(issue.input))} characters.`
		})
		.transform((value) => value || undefined)
		.optional()
		.describe(description);
}

/** Rejects case-insensitive duplicates in a string array. */
export function uniqueIgnoringCase(label: string) {
	return (values: string[], ctx: z.RefinementCtx) => {
		const seen = new Set<string>();
		for (const value of values) {
			const key = value.toLowerCase();
			if (seen.has(key))
				ctx.addIssue({ code: 'custom', message: `duplicate ${label}: '${value}'.` });
			seen.add(key);
		}
	};
}

/** Rejects exact duplicates in a string array. */
export function unique(label: string) {
	return (values: string[], ctx: z.RefinementCtx) => {
		const duplicate = values.find((value, index) => values.indexOf(value) !== index);
		if (duplicate) ctx.addIssue({ code: 'custom', message: `duplicate ${label}: '${duplicate}'.` });
	};
}

/** Money in account currency units (e.g. 1.25), converted to micros for the API. */
export function money(description: string) {
	return z
		.number()
		.positive()
		.max(1_000_000_000)
		.transform((amount) => Math.round(amount * 100) * 10_000)
		.describe(`${description} In account currency units (e.g. 1.25), not micros.`);
}

/** A calendar date, `YYYY-MM-DD`. */
export const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD.')
	.refine((value) => {
		const date = new Date(`${value}T00:00:00Z`);
		return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
	}, 'must be a real calendar date.');

export const validateOnly = z
	.boolean()
	.default(false)
	.describe(
		'Dry run: Google validates the request without executing it. Use it to check a change before making it.'
	);

export const matchType = upperEnum(['EXACT', 'PHRASE', 'BROAD'] as const).describe(
	'Keyword match type.'
);

/** Micros (int64 as string or number from the API) → currency units. */
export const fromMicros = (micros: unknown) =>
	micros === undefined || micros === null ? null : Number(micros) / 1e6;

/** REST omits zero values and sends int64 as strings. */
export const num = (value: unknown) => Number(value ?? 0);
