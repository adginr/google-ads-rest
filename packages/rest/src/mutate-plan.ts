/**
 * Publishing many related entities at once, e.g. a whole Search campaign: budget → campaign → criteria →
 * ad groups → keywords → ads → negatives. Entities refer to each other through temporary resource names
 * (negative IDs) that Google resolves within one request, and results map back to the caller's own keys.
 *
 * ```ts
 * const plan = new MutatePlan('1234567890');
 * const budget = plan.tempResourceName('campaignBudgets');
 * plan.add(campaignBudgetOperation({ resourceName: budget, name: 'Shoes', amountMicros: 20e6, explicitlyShared: false }), 'budget');
 * const campaign = plan.tempResourceName('campaigns');
 * plan.add(searchCampaignOperation({ resourceName: campaign, budget, … }), 'campaign');
 * await plan.publish(ads, { validateOnly: true }); // dry run
 * const { resourceNames } = await plan.publish(ads); // { budget: 'customers/…/campaignBudgets/…', campaign: … }
 * ```
 *
 * `publish` is one atomic mutate (all or nothing, at most 10 000 operations). Bigger plans go through a batch
 * job (`publishInBackground`): no operation limit, but not atomic and without a dry run.
 */
import type { GoogleAdsClient } from './client.ts';
import { GoogleAdsError } from './errors.ts';
import type { resources, services } from './types/index.ts';

/** GoogleAdsService.Mutate accepts at most this many operations per request. */
export const MAX_MUTATE_OPERATIONS = 10_000;

/** Collections whose entities other operations refer to by resource name. */
export type TempCollection =
	| 'campaignBudgets'
	| 'campaigns'
	| 'adGroups'
	| 'sharedSets'
	| 'assets'
	| 'biddingStrategies'
	| 'labels';

export interface PublishResult {
	validateOnly: boolean;
	/** Caller key → created (or updated) resource name; every key is null on a dry run. */
	resourceNames: Record<string, string | null>;
	/** Google's responses in operation order; empty on a dry run. */
	responses: services.MutateOperationResponse[];
}

export interface BatchJobProgress {
	batchJob: string;
	status: NonNullable<resources.BatchJob['status']>;
	totalOperations: number;
	executedOperations: number;
	/** 0-1, Google's estimate. */
	completionRatio: number;
}

export interface BatchJobOutcome {
	batchJob: string;
	/** Caller key → resource name; null where the operation failed. */
	resourceNames: Record<string, string | null>;
	/** Failed operations. Operations depending on a failed one fail too. */
	failures: Array<{ index: number; key: string | null; message: string; error: GoogleAdsError }>;
}

export interface BackgroundOptions {
	/** Operations per AddBatchJobOperations request. Default 1000. */
	chunkSize?: number;
	/** Delay between status checks. Default 5 s. */
	pollIntervalMs?: number;
	/** Give up waiting (the job keeps running at Google) after this long. Default 30 min. */
	timeoutMs?: number;
	onProgress?: (progress: BatchJobProgress) => void;
	signal?: AbortSignal;
}

const TEMP_NAME = /^customers\/(\d+)\/([A-Za-z]+)\/(-\d+)$/;

export class MutatePlan {
	readonly customerId: string;
	readonly #operations: services.MutateOperation[] = [];
	readonly #keys: Array<string | null> = [];
	readonly #usedKeys = new Set<string>();
	readonly #reserved = new Set<string>();
	readonly #created = new Set<string>();
	#nextTempId = -1;

	constructor(customerId: string) {
		this.customerId = customerId.replaceAll('-', '');
	}

	/**
	 * Reserves a temporary resource name, e.g. `customers/1/campaigns/-3`. Set it as `resourceName` on the
	 * create operation, then use it wherever later operations refer to that entity.
	 */
	tempResourceName(collection: TempCollection): string {
		const name = `customers/${this.customerId}/${collection}/${this.#nextTempId--}`;
		this.#reserved.add(name);
		return name;
	}

	/**
	 * Appends an operation; `key` names its result in `resourceNames`. Throws when the operation refers to a
	 * temporary name that no earlier operation creates, since Google resolves them in order.
	 */
	add(operation: services.MutateOperation, key?: string): this {
		if (key !== undefined && this.#usedKeys.has(key))
			throw new GoogleAdsError(`Duplicate plan key '${key}'.`);
		const created = createdResourceName(operation);
		for (const name of tempNames(operation)) {
			const match = TEMP_NAME.exec(name)!;
			if (match[1] !== this.customerId)
				throw new GoogleAdsError(
					`Temporary name ${name} belongs to another customer than ${this.customerId}.`
				);
			if (!this.#reserved.has(name))
				throw new GoogleAdsError(`${name} was not reserved with tempResourceName().`);
			if (name === created) {
				if (this.#created.has(name))
					throw new GoogleAdsError(`${name} is created by two operations.`);
			} else if (!this.#created.has(name)) {
				throw new GoogleAdsError(
					`${name} is used before the operation that creates it; add that operation first.`
				);
			}
		}
		if (created && TEMP_NAME.test(created)) this.#created.add(created);
		this.#operations.push(operation);
		this.#keys.push(key ?? null);
		if (key !== undefined) this.#usedKeys.add(key);
		return this;
	}

	get operations(): readonly services.MutateOperation[] {
		return this.#operations;
	}

	/** Caller key of each operation, in order (null for unkeyed ones). Persist it to collect batch results later. */
	get keys(): ReadonlyArray<string | null> {
		return this.#keys;
	}

	get size(): number {
		return this.#operations.length;
	}

	/**
	 * Sends the plan as one atomic mutate: everything is created or nothing is. Run it with `validateOnly`
	 * first to have Google check every operation without changing anything.
	 */
	async publish(
		ads: GoogleAdsClient,
		{ validateOnly = false }: { validateOnly?: boolean } = {}
	): Promise<PublishResult> {
		if (this.size > MAX_MUTATE_OPERATIONS)
			throw new GoogleAdsError(
				`The plan has ${this.size} operations; one mutate takes at most ${MAX_MUTATE_OPERATIONS}. ` +
					'Split it (e.g. one plan per campaign) or use publishInBackground().'
			);
		const responses = await ads.mutate(this.customerId, [...this.#operations], { validateOnly });
		return {
			validateOnly,
			resourceNames: mapKeys(this.#keys, (index) =>
				validateOnly ? null : responseResourceName(responses[index])
			),
			responses
		};
	}

	/**
	 * Creates a batch job, uploads the operations in chunks and starts it. Returns the job's resource name;
	 * follow it with `waitForBatchJob` and `collectBatchJobResults` (with `plan.keys`), or use
	 * `publishInBackground` to do all three.
	 */
	async submitBatchJob(
		ads: GoogleAdsClient,
		{ chunkSize = 1000 }: Pick<BackgroundOptions, 'chunkSize'> = {}
	): Promise<string> {
		if (!this.size) throw new GoogleAdsError('The plan has no operations.');
		const batchJob = await ads.createBatchJob(this.customerId);
		let sequenceToken: string | undefined;
		for (let start = 0; start < this.size; start += chunkSize) {
			const added = await ads.addBatchJobOperations(
				batchJob,
				this.#operations.slice(start, start + chunkSize),
				sequenceToken
			);
			sequenceToken = added.nextSequenceToken;
		}
		await ads.runBatchJob(batchJob);
		return batchJob;
	}

	/** Submits the plan as a batch job, reports progress while it runs, and maps the results to keys. */
	async publishInBackground(
		ads: GoogleAdsClient,
		options: BackgroundOptions = {}
	): Promise<BatchJobOutcome> {
		const batchJob = await this.submitBatchJob(ads, options);
		await waitForBatchJob(ads, batchJob, options);
		return collectBatchJobResults(ads, batchJob, this.#keys);
	}
}

/** Polls a batch job until it is DONE, calling `onProgress` after each check. */
export async function waitForBatchJob(
	ads: GoogleAdsClient,
	batchJob: string,
	{
		pollIntervalMs = 5000,
		timeoutMs = 30 * 60_000,
		onProgress,
		signal
	}: Omit<BackgroundOptions, 'chunkSize'> = {}
): Promise<BatchJobProgress> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		signal?.throwIfAborted();
		const job = await ads.getBatchJob(batchJob);
		if (!job) throw new GoogleAdsError(`Batch job ${batchJob} not found.`);
		const progress: BatchJobProgress = {
			batchJob,
			status: job.status ?? 'UNKNOWN',
			totalOperations: Number(job.metadata?.operationCount ?? 0),
			executedOperations: Number(job.metadata?.executedOperationCount ?? 0),
			completionRatio: job.status === 'DONE' ? 1 : (job.metadata?.estimatedCompletionRatio ?? 0)
		};
		onProgress?.(progress);
		if (progress.status === 'DONE') return progress;
		if (Date.now() + pollIntervalMs > deadline)
			throw new GoogleAdsError(
				`Batch job ${batchJob} is still ${progress.status} after ${Math.round(timeoutMs / 1000)} s; ` +
					'it keeps running at Google. Check it again later with waitForBatchJob().'
			);
		await sleep(pollIntervalMs, signal);
	}
}

/** Maps a finished batch job's results to the plan keys (`plan.keys`) and collects failures. */
export async function collectBatchJobResults(
	ads: GoogleAdsClient,
	batchJob: string,
	keys: ReadonlyArray<string | null>
): Promise<BatchJobOutcome> {
	const results = await ads.listBatchJobResults(batchJob);
	const byIndex = new Map(results.map((result) => [Number(result.operationIndex ?? 0), result]));
	const failures: BatchJobOutcome['failures'] = [];
	for (const [index, result] of [...byIndex].sort(([a], [b]) => a - b)) {
		if (result.status?.code) {
			const error = GoogleAdsError.fromStatus(result.status);
			failures.push({ index, key: keys[index] ?? null, message: error.message, error });
		}
	}
	return {
		batchJob,
		resourceNames: mapKeys(keys, (index) => {
			const result = byIndex.get(index);
			return result?.status?.code ? null : responseResourceName(result?.mutateOperationResponse);
		}),
		failures
	};
}

function mapKeys(
	keys: ReadonlyArray<string | null>,
	resourceNameAt: (index: number) => string | null
): Record<string, string | null> {
	const names: Record<string, string | null> = {};
	keys.forEach((key, index) => {
		if (key !== null) names[key] = resourceNameAt(index);
	});
	return names;
}

/** `{ campaignResult: { resourceName } }` → the resource name. */
function responseResourceName(response: services.MutateOperationResponse | undefined) {
	const result = Object.values(response ?? {})[0] as { resourceName?: string } | undefined;
	return result?.resourceName ?? null;
}

/** The resource name a create operation sets on its new entity, if any. */
function createdResourceName(operation: services.MutateOperation): string | undefined {
	const inner = Object.values(operation)[0] as { create?: { resourceName?: string } } | undefined;
	return inner?.create?.resourceName;
}

/** Every temporary resource name anywhere in an operation. */
function tempNames(operation: services.MutateOperation): Set<string> {
	const names = new Set<string>();
	JSON.stringify(operation, (_key, value: unknown) => {
		if (typeof value === 'string' && TEMP_NAME.test(value)) names.add(value);
		return value;
	});
	return names;
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}
