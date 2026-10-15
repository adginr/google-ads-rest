import { z } from 'zod';
import { resourceNames } from '../resource-names.ts';
import type { services } from '../types/index.ts';
import { defineTool } from './define-tool.ts';
import { customerId, fromMicros, upperEnum } from './schemas.ts';

export const generateKeywordIdeas = defineTool({
	name: 'generate_keyword_ideas',
	title: 'Generate keyword ideas',
	description:
		'Keyword Planner: generates keyword ideas with average monthly searches, competition and top-of-page ' +
		'bid ranges, from seed keywords, a page URL, or both. Use it to research new keywords or estimate ' +
		'demand before adding keywords. Bids are in account currency units.',
	input: z
		.object({
			customerId,
			keywords: z
				.array(z.string().trim().min(1))
				.max(20)
				.optional()
				.describe('Seed keywords, e.g. ["car lease dubai"]. Up to 20.'),
			pageUrl: z
				.url({ protocol: /^https?$/ })
				.optional()
				.describe('A page (or whole site) to extract ideas from.'),
			locationIds: z
				.array(z.number().int().positive())
				.optional()
				.describe(
					'Geo target constant IDs, e.g. 2784 for the United Arab Emirates, 2840 for the United States. ' +
						'Find others with the search tool on geo_target_constant.'
				),
			languageId: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Language constant ID, e.g. 1000 English, 1019 Arabic, 1031 Russian.'),
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
		}),
	output: z.object({
		ideas: z.array(
			z.object({
				keyword: z.string(),
				avgMonthlySearches: z.number().nullable(),
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
				includeAdultKeywords: input.includeAdultKeywords
			},
			{ maxResults: input.limit }
		);

		const toNumber = (value: string | undefined) => (value === undefined ? null : Number(value));
		return {
			ideas: results.map(({ text, keywordIdeaMetrics: m }) => ({
				keyword: text ?? '',
				avgMonthlySearches: toNumber(m?.avgMonthlySearches),
				competition: m?.competition ?? null,
				competitionIndex: toNumber(m?.competitionIndex),
				lowTopOfPageBid: fromMicros(m?.lowTopOfPageBidMicros),
				highTopOfPageBid: fromMicros(m?.highTopOfPageBidMicros)
			}))
		};
	}
});
