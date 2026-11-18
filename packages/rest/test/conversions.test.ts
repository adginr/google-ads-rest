import { describe, expect, it } from 'vitest';
import { GoogleAdsError } from '../src/errors.ts';
import { resourceNames } from '../src/resource-names.ts';
import type { services } from '../src/types/index.ts';
import { fakeApi } from './fake-api.ts';

const action = resourceNames.conversionAction('1234567890', '555');
const conversion = (gclid: string): services.ClickConversion => ({
	conversionAction: action,
	conversionDateTime: '2026-11-18 14:05:00+04:00',
	gclid,
	conversionValue: 250,
	currencyCode: 'AED'
});

describe('uploadClickConversions', () => {
	it('uploads with partial failure on and returns one result per conversion', async () => {
		const api = fakeApi({
			other: (request) => [
				200,
				{
					jobId: '42',
					results: (request.body!.conversions as services.ClickConversion[]).map((c) => ({
						conversionAction: c.conversionAction,
						conversionDateTime: c.conversionDateTime,
						gclid: c.gclid
					}))
				}
			]
		});
		const result = await api.ads.uploadClickConversions(
			'1234567890',
			[conversion('a'), conversion('b')],
			{ jobId: 7 }
		);

		expect(api.requests).toHaveLength(1);
		const [request] = api.requests;
		expect(request!.method).toBe('POST');
		expect(request!.path).toBe('/customers/1234567890:uploadClickConversions');
		expect(request!.body).toMatchObject({ partialFailure: true, validateOnly: false, jobId: 7 });
		expect(result.jobId).toBe('42');
		expect(result.failures).toEqual([]);
		expect(result.results.map((r) => r?.gclid)).toEqual(['a', 'b']);
	});

	it('reports rejected conversions by index and nulls their results', async () => {
		const api = fakeApi({
			other: () => [
				200,
				{
					results: [{ gclid: 'a', conversionAction: action }, {}],
					partialFailureError: {
						code: 3,
						message: 'Multiple errors in details.',
						details: [
							{
								'@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
								errors: [
									{
										errorCode: { conversionUploadError: 'UNPARSEABLE_GCLID' },
										message: 'The click ID could not be decoded.',
										location: {
											fieldPathElements: [
												{ fieldName: 'conversions', index: 1 },
												{ fieldName: 'gclid' }
											]
										}
									}
								]
							}
						]
					}
				}
			]
		});
		const result = await api.ads.uploadClickConversions('1234567890', [
			conversion('a'),
			conversion('bad')
		]);

		expect(result.results[0]?.gclid).toBe('a');
		expect(result.results[1]).toBeNull();
		expect(result.failures).toEqual([
			{
				code: 'conversionUploadError.UNPARSEABLE_GCLID',
				message: 'The click ID could not be decoded.',
				field: 'conversions[1].gclid',
				trigger: undefined,
				index: 1
			}
		]);
	});

	it.each([
		['no details', undefined],
		[
			'a detail of another type',
			[{ '@type': 'type.googleapis.com/google.rpc.DebugInfo', detail: 'x' }]
		]
	])('never loses a partial failure that has %s', async (_, details) => {
		const api = fakeApi({
			other: () => [
				200,
				{
					results: [{ gclid: 'a', conversionAction: action }, {}],
					partialFailureError: {
						code: 3,
						message: 'Request contains an invalid argument.',
						...(details ? { details } : {})
					}
				}
			]
		});
		const result = await api.ads.uploadClickConversions('1234567890', [
			conversion('a'),
			conversion('bad')
		]);

		expect(result.failures).toEqual([
			{ code: 'rpc.INVALID_ARGUMENT', message: 'Request contains an invalid argument.' }
		]);
		expect(result.failures[0]).not.toHaveProperty('index');
		expect(result.results[0]?.gclid).toBe('a');
		expect(result.results[1]).toBeNull();
	});

	it('keeps a fallback entry when the partial failure has no message either', async () => {
		const api = fakeApi({ other: () => [200, { results: [{}], partialFailureError: {} }] });
		const result = await api.ads.uploadClickConversions('1234567890', [conversion('a')]);
		expect(result.failures).toEqual([
			{ code: 'rpc.UNKNOWN', message: 'Google reported a partial failure without details.' }
		]);
		expect(result.results).toEqual([null]);
	});

	it('passes validateOnly through', async () => {
		const api = fakeApi({ other: () => [200, {}] });
		const result = await api.ads.uploadClickConversions('1234567890', [conversion('a')], {
			validateOnly: true
		});
		expect(api.requests[0]!.body?.validateOnly).toBe(true);
		expect(result.results).toEqual([null]);
	});

	it.each([
		['no conversions', [], 'at least one conversion'],
		['too many', Array.from({ length: 2001 }, () => conversion('a')), 'at most 2000'],
		[
			'no conversion action',
			[{ ...conversion('a'), conversionAction: undefined }],
			'conversions[0]: conversionAction is required'
		],
		[
			'ISO date time',
			[conversion('a'), { ...conversion('b'), conversionDateTime: '2026-11-18T14:05:00Z' }],
			"conversions[1]: conversionDateTime must look like '2026-11-18 14:05:00+04:00'"
		],
		[
			'no click identifier',
			[{ ...conversion('a'), gclid: undefined }],
			'needs gclid, gbraid, wbraid or userIdentifiers'
		]
	])('rejects %s before any request', async (_, conversions, message) => {
		const api = fakeApi();
		const upload = api.ads.uploadClickConversions('1234567890', conversions);
		await expect(upload).rejects.toThrow(GoogleAdsError);
		await expect(upload).rejects.toThrow(message);
		expect(api.requests).toHaveLength(0);
	});

	it('accepts enhanced conversions for leads without a click ID', async () => {
		const api = fakeApi({ other: () => [200, { results: [{ conversionAction: action }] }] });
		const result = await api.ads.uploadClickConversions('1234567890', [
			{ ...conversion('a'), gclid: undefined, userIdentifiers: [{ hashedEmail: 'f00d' }] }
		]);
		expect(result.results[0]).toEqual({ conversionAction: action });
	});
});
