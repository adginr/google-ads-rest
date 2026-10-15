import type { errors } from './types/index.ts';

/** One entry of a GoogleAdsFailure, e.g. `{ code: 'queryError.UNRECOGNIZED_FIELD', message: '…' }`. */
export interface GoogleAdsErrorEntry {
	code: string;
	message: string;
	/** Dotted path to the offending field in a mutate request, e.g. `mutateOperations[0].adGroupOperation.create.name`. */
	field?: string;
	/** The value that triggered the error, when Google reports it. */
	trigger?: unknown;
}

/**
 * Every failure from this package: bad configuration, OAuth refresh, API errors, short mutate responses.
 * The message leads with Google's specific errors (what a caller, human or model, needs to fix the request),
 * not the generic top-level "invalid argument".
 */
export class GoogleAdsError extends Error {
	/** HTTP status of the failed request, if there was one. */
	readonly status?: number;
	/** Google's specific errors from the GoogleAdsFailure detail. */
	readonly errors: GoogleAdsErrorEntry[];
	/** Request ID to quote when contacting Google support. */
	readonly requestId?: string;

	constructor(
		message: string,
		{
			status,
			errors = [],
			requestId,
			cause
		}: { status?: number; errors?: GoogleAdsErrorEntry[]; requestId?: string; cause?: unknown } = {}
	) {
		super(message, { cause });
		this.name = 'GoogleAdsError';
		this.status = status;
		this.errors = errors;
		this.requestId = requestId;
	}

	/**
	 * Builds an error from a REST error body (google.rpc.Status with a GoogleAdsFailure detail).
	 * https://developers.google.com/google-ads/api/docs/best-practices/error-types
	 */
	static fromResponse(httpStatus: number, body: unknown): GoogleAdsError {
		const error = (body as { error?: RestError } | undefined)?.error;
		const failure = error?.details?.find((detail) =>
			detail['@type']?.endsWith('.GoogleAdsFailure')
		) as (errors.GoogleAdsFailure & { '@type': string }) | undefined;

		const entries = (failure?.errors ?? []).map((entry): GoogleAdsErrorEntry => ({
			code: Object.entries(entry.errorCode ?? {})
				.map(([kind, value]) => `${kind}.${value}`)
				.join(', '),
			message: entry.message ?? '',
			field: entry.location?.fieldPathElements
				?.map((el) => (el.index === undefined ? el.fieldName : `${el.fieldName}[${el.index}]`))
				.join('.'),
			trigger: entry.trigger && Object.values(entry.trigger)[0]
		}));

		const summary = entries.length
			? entries
					.map((e) => `${e.code}: ${e.message}${e.field ? ` (field: ${e.field})` : ''}`)
					.join('; ')
			: (error?.message ?? 'Unknown error');
		const status = error?.status ? ` ${error.status}` : '';
		return new GoogleAdsError(`Google Ads API ${httpStatus}${status}: ${summary}`, {
			status: httpStatus,
			errors: entries,
			requestId: failure?.requestId
		});
	}
}

/** REST error envelope: google.rpc.Status plus the HTTP status name. */
interface RestError {
	message?: string;
	status?: string;
	details?: Array<{ '@type'?: string }>;
}
