import { describe, expect, it } from 'vitest';
import { buildGaql, escapeGaqlString, gaqlString, unsafeConditionReason } from '../src/gaql.ts';
import { compositeIdParts, idFromResourceName } from '../src/resource-names.ts';

describe('GAQL helpers', () => {
	it('escapes backslashes before quotes', () => {
		expect(escapeGaqlString("o'brien leasing")).toBe("o\\'brien leasing");
		expect(escapeGaqlString('g63\\lease')).toBe('g63\\\\lease');
		expect(gaqlString("it's")).toBe("'it\\'s'");
	});

	it.each([
		"campaign.status = 'ENABLED'",
		'metrics.clicks > 10',
		"campaign.name LIKE '%FROM the WHERE%'",
		"ad_group_criterion.keyword.text = 'select; -- cars'"
	])('accepts %s', (condition) => {
		expect(unsafeConditionReason(condition)).toBeUndefined();
	});

	it.each([
		['campaign.id = 1 LIMIT 5', 'LIMIT'],
		['campaign.id = 1 ORDER  BY campaign.id', 'ORDER  BY'.toUpperCase()],
		['campaign.id = 1; DROP', 'terminator'],
		['campaign.id = 1 -- comment', 'comment'],
		["campaign.name = 'open", 'unclosed']
	])('rejects %s', (condition, reason) => {
		expect(unsafeConditionReason(condition)).toContain(reason);
	});

	it('assembles a query', () => {
		expect(
			buildGaql({
				fields: ['campaign.id', 'campaign.name'],
				resource: 'campaign',
				conditions: ["campaign.status = 'ENABLED'", 'metrics.clicks > 0'],
				orderings: ['campaign.name ASC'],
				limit: 10,
				parameters: { omit_unselected_resource_names: true }
			})
		).toBe(
			"SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = 'ENABLED' AND metrics.clicks > 0 " +
				'ORDER BY campaign.name ASC LIMIT 10 PARAMETERS omit_unselected_resource_names=true'
		);
	});
});

describe('resource names', () => {
	it('extracts the own ID of composite names', () => {
		expect(idFromResourceName('customers/1/adGroupCriteria/111~222', 'adGroupCriteria')).toBe(
			'222'
		);
		expect(idFromResourceName('customers/1/adGroups/333', 'adGroups')).toBe('333');
		expect(idFromResourceName('customers/1/adGroups/333', 'campaigns')).toBeUndefined();
		expect(idFromResourceName(undefined, 'adGroups')).toBeUndefined();
	});

	it('splits composite IDs', () => {
		expect(compositeIdParts('customers/1/campaignAssets/12~34~CALLOUT')).toEqual([
			'12',
			'34',
			'CALLOUT'
		]);
	});
});
