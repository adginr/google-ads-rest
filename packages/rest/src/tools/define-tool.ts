import type { z } from 'zod';
import type { GoogleAdsClient } from '../client.ts';

/** Everything a tool's `run` may use. Add shared services here, not as module imports. */
export interface ToolContext {
	ads: GoogleAdsClient;
}

/**
 * One Google Ads capability for an AI agent, described once and served by any adapter:
 * an MCP server (`@adginr/google-ads-mcp`), TanStack AI, the Vercel AI SDK, or a plain function call.
 */
export interface AdsTool<
	Input extends z.ZodObject = z.ZodObject,
	Output extends z.ZodObject = z.ZodObject
> {
	/** snake_case `verb_noun`, unique across `adsTools`. This is what the model calls. */
	name: string;
	/** Short human label. */
	title: string;
	/** Written for the model: what it does, when to use it over other tools, what it returns. */
	description: string;
	input: Input;
	output: Output;
	/**
	 * `readOnly: false` marks a mutating tool: hosts should ask the user to approve each call.
	 * `destructive` (default: `!readOnly`) marks changes that are hard to undo, such as removals.
	 */
	annotations: { readOnly: boolean; destructive?: boolean; idempotent?: boolean };
	run: (input: z.output<Input>, ctx: ToolContext) => Promise<z.input<Output>>;
}

/** Identity helper that infers `run`'s argument and return types from the schemas. */
export function defineTool<Input extends z.ZodObject, Output extends z.ZodObject>(
	tool: AdsTool<Input, Output>
): AdsTool<Input, Output> {
	return tool;
}
