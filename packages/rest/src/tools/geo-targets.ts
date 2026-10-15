import { z } from 'zod';
import { defineTool } from './define-tool.ts';
import { text } from './schemas.ts';

export const suggestGeoTargets = defineTool({
	name: 'suggest_geo_targets',
	title: 'Suggest geo targets',
	description:
		'Finds geo target constants (countries, regions, cities, postal codes, ...) by name. Partial names ' +
		'work ("Mün" suggests Munich), so it suits search-as-you-type. Use it to turn a place name into the ' +
		'location ID that generate_keyword_ideas (locationIds) and location targeting need. Returns each ' +
		"match's ID, names, country, type and approximate reach. Not tied to an account.",
	input: z.object({
		names: z
			.array(text(100, 'A location name or the start of one.'))
			.min(1)
			.max(25)
			.describe(
				'Location names to look up, e.g. ["Munich"]. Suggestions for all names are merged.'
			),
		locale: z
			.string()
			.trim()
			.regex(
				/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/,
				'locale is a language code such as en or de.'
			)
			.default('en')
			.describe('Language for the returned names, e.g. en, de. Default en.'),
		countryCode: z
			.string()
			.trim()
			.regex(/^[A-Za-z]{2}$/, 'countryCode is a two-letter ISO-3166-1 code such as DE.')
			.transform((code) => code.toUpperCase())
			.optional()
			.describe('Only suggest locations in this country (ISO-3166-1 alpha-2, e.g. DE).')
	}),
	output: z.object({
		suggestions: z.array(
			z.object({
				id: z.number().describe('Geo target constant ID, e.g. for locationIds.'),
				name: z
					.string()
					.nullable()
					.describe('Name, translated to the locale where Google has a translation.'),
				canonicalName: z
					.string()
					.nullable()
					.describe('Full English name with parents, e.g. "Munich,Bavaria,Germany".'),
				countryCode: z.string().nullable(),
				targetType: z.string().nullable().describe('City, Country, Region, Postal Code, ...'),
				status: z.string().nullable().describe('ENABLED or REMOVAL_PLANNED.'),
				reach: z.number().nullable().describe('Approximate users targeted, rounded to 100.'),
				searchTerm: z.string().nullable().describe('Which of the names matched.')
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run(input, { ads }) {
		const suggestions = await ads.suggestGeoTargetConstants(input.names, {
			locale: input.locale,
			countryCode: input.countryCode
		});
		return {
			suggestions: suggestions.flatMap(({ geoTargetConstant: geo, reach, searchTerm }) =>
				geo?.id === undefined
					? []
					: [
							{
								id: Number(geo.id),
								name: geo.name ?? null,
								canonicalName: geo.canonicalName ?? null,
								countryCode: geo.countryCode ?? null,
								targetType: geo.targetType ?? null,
								status: geo.status ?? null,
								reach: reach === undefined ? null : Number(reach),
								searchTerm: searchTerm ?? null
							}
						]
			)
		};
	}
});
