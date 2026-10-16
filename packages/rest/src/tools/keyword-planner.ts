import { z } from 'zod';
import { resourceNames } from '../resource-names.ts';
import type { common, services } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import { customerId, fromMicros, num, upperEnum } from './schemas.ts';

const MONTHS = [
	'JANUARY',
	'FEBRUARY',
	'MARCH',
	'APRIL',
	'MAY',
	'JUNE',
	'JULY',
	'AUGUST',
	'SEPTEMBER',
	'OCTOBER',
	'NOVEMBER',
	'DECEMBER'
] as const;

const yearMonth = (description: string) =>
	z
		.string()
		.trim()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'months are YYYY-MM, e.g. 2025-09.')
		.optional()
		.describe(description);

/** `'2025-09'` → `{ year: '2025', month: 'SEPTEMBER' }`. */
function toYearMonth(value: string): common.YearMonth {
	const [year, month] = value.split('-');
	return { year, month: MONTHS[Number(month) - 1] };
}

export const generateKeywordIdeas = defineTool({
	name: 'generate_keyword_ideas',
	title: 'Generate keyword ideas',
	description:
		'Keyword Planner: generates keyword ideas with average monthly searches, searches per month, ' +
		'competition and top-of-page bid ranges, from seed keywords, a page URL, or both. Use it to research ' +
		'new keywords or estimate demand before adding keywords. Searches per month cover the last 12 months ' +
		'unless fromMonth/toMonth set a range; ask for 13 or more months (e.g. 2025-08 to 2026-09) to compare a ' +
		'month with the same month a year earlier. Limits per request: 20 seed keywords and 10 locations; ' +
		'split larger requests. Find location IDs with suggest_geo_targets and language IDs with the search ' +
		'tool on language_constant. Bids are in account currency units.',
	input: z
		.object({
			customerId,
			keywords: z
				.array(z.string().trim().min(1))
				.max(20, 'Google accepts at most 20 seed keywords per request.')
				.optional()
				.describe('Seed keywords, e.g. ["car lease dubai"]. Up to 20.'),
			pageUrl: z
				.url({ protocol: /^https?$/ })
				.optional()
				.describe('A page (or whole site) to extract ideas from.'),
			locationIds: z
				.array(z.number().int().positive())
				.max(10, 'Google accepts at most 10 locations per request.')
				.optional()
				.describe(
					'Geo target constant IDs, up to 10, e.g. 2784 for the United Arab Emirates, 2840 for the ' +
						'United States. Find others with suggest_geo_targets. Omit for all locations.'
				),
			languageId: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Language constant ID, e.g. 1000 English, 1019 Arabic, 1031 Russian.'),
			fromMonth: yearMonth(
				'First month of searches per month, YYYY-MM. Set together with toMonth; default: 12 months ' +
					'ending with the last complete month.'
			),
			toMonth: yearMonth('Last month of searches per month (inclusive), YYYY-MM.'),
			network: upperEnum(['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS'] as const)
				.default('GOOGLE_SEARCH')
				.describe('Which network the search volumes are for.'),
			includeAdultKeywords: z.boolean().default(false),
			limit: z
				.number()
				.int()
				.positive()
				.max(10_000)
				.default(500)
				.describe('Maximum ideas to return.')
		})
		.refine((input) => input.keywords?.length || input.pageUrl, {
			message: 'Provide keywords, pageUrl, or both.'
		})
		.refine((input) => (input.fromMonth === undefined) === (input.toMonth === undefined), {
			message: 'Set fromMonth and toMonth together.'
		})
		.refine((input) => !input.fromMonth || !input.toMonth || input.fromMonth <= input.toMonth, {
			message: 'fromMonth must not be after toMonth.'
		}),
	output: z.object({
		ideas: z.array(
			z.object({
				keyword: z.string(),
				avgMonthlySearches: z.number().nullable(),
				monthlySearches: z
					.array(
						z.object({
							year: z.number(),
							month: z.number().describe('1-12.'),
							searches: z.number()
						})
					)
					.describe('Approximate searches per month, oldest first.'),
				competition: z.string().nullable().describe('LOW, MEDIUM or HIGH.'),
				competitionIndex: z.number().nullable().describe('0-100.'),
				lowTopOfPageBid: z.number().nullable(),
				highTopOfPageBid: z.number().nullable()
			})
		)
	}),
	annotations: { readOnly: true, idempotent: true },
	async run(input, { ads }) {
		const { keywords, pageUrl } = input;
		const seed: Partial<services.GenerateKeywordIdeasRequest> =
			keywords?.length && pageUrl
				? { keywordAndUrlSeed: { keywords, url: pageUrl } }
				: keywords?.length
					? { keywordSeed: { keywords } }
					: { urlSeed: { url: pageUrl } };

		const results = await ads.generateKeywordIdeas(
			input.customerId,
			{
				...seed,
				language:
					input.languageId === undefined
						? undefined
						: resourceNames.languageConstant(input.languageId),
				geoTargetConstants: input.locationIds?.map(resourceNames.geoTargetConstant),
				keywordPlanNetwork: input.network,
				includeAdultKeywords: input.includeAdultKeywords,
				historicalMetricsOptions:
					input.fromMonth && input.toMonth
						? {
								yearMonthRange: {
									start: toYearMonth(input.fromMonth),
									end: toYearMonth(input.toMonth)
								}
							}
						: undefined
			},
			{ maxResults: input.limit }
		);

		const toNumber = (value: string | undefined) => (value === undefined ? null : Number(value));
		return {
			ideas: results.map(({ text, keywordIdeaMetrics: m }) => ({
				keyword: text ?? '',
				avgMonthlySearches: toNumber(m?.avgMonthlySearches),
				monthlySearches: (m?.monthlySearchVolumes ?? [])
					.map((volume) => ({
						year: Number(volume.year),
						month: MONTHS.indexOf(volume.month as (typeof MONTHS)[number]) + 1,
						searches: num(volume.monthlySearches)
					}))
					.filter((volume) => volume.month > 0)
					.sort((a, b) => a.year - b.year || a.month - b.month),
				competition: m?.competition ?? null,
				competitionIndex: toNumber(m?.competitionIndex),
				lowTopOfPageBid: fromMicros(m?.lowTopOfPageBidMicros),
				highTopOfPageBid: fromMicros(m?.highTopOfPageBidMicros)
			}))
		};
	}
});
