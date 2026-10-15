/**
 * End-to-end: starts the CLI over stdio like an MCP client would and checks the advertised surface.
 * The snapshot is the public contract: a renamed tool or a new required input shows up as a diff.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

async function rpc(args: string[], requests: Array<{ method: string; params?: unknown }>) {
	const child = spawn(process.execPath, [CLI, ...args], {
		env: { PATH: process.env.PATH, GOOGLE_ADS_ENV_FILE: '/nonexistent/.env' },
		stdio: ['pipe', 'pipe', 'pipe']
	});
	const messages = [
		{
			jsonrpc: '2.0',
			id: 0,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' }
			}
		},
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		...requests.map((request, i) => ({ jsonrpc: '2.0', id: i + 1, ...request }))
	];
	child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n');

	const responses = new Map<number, { result?: Record<string, unknown>; error?: unknown }>();
	let buffer = '';
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('MCP server did not answer in time')), 10_000);
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const message = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (typeof message.id === 'number') responses.set(message.id, message);
			}
			if (responses.size === requests.length + 1) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	child.kill();
	return requests.map((_, i) => responses.get(i + 1)!);
}

type ListedTool = {
	name: string;
	inputSchema: { required?: string[] };
	annotations: { readOnlyHint: boolean; destructiveHint: boolean };
};

describe('google-ads-mcp over stdio', () => {
	it('lists every tool with its required inputs and hints', { timeout: 15_000 }, async () => {
		const [tools, resources] = await rpc(
			[],
			[{ method: 'tools/list' }, { method: 'resources/list' }]
		);
		const listed = (tools!.result!.tools as ListedTool[]).map((tool) => ({
			name: tool.name,
			required: tool.inputSchema.required ?? [],
			readOnly: tool.annotations.readOnlyHint,
			destructive: tool.annotations.destructiveHint
		}));
		expect(listed).toMatchSnapshot();
		expect((resources!.result!.resources as Array<{ uri: string }>).map((r) => r.uri)).toEqual([
			'google-ads://docs/release-notes',
			'google-ads://docs/metrics',
			'google-ads://docs/segments',
			'google-ads://docs/discovery-document'
		]);
	});

	it('exposes only read-only tools with --read-only', { timeout: 15_000 }, async () => {
		const [tools] = await rpc(['--read-only'], [{ method: 'tools/list' }]);
		const listed = tools!.result!.tools as ListedTool[];
		expect(listed.length).toBe(8);
		expect(listed.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
	});

	it(
		'reports missing configuration as a tool error the model can read',
		{ timeout: 15_000 },
		async () => {
			const [call] = await rpc(
				[],
				[{ method: 'tools/call', params: { name: 'list_accessible_customers', arguments: {} } }]
			);
			expect(call!.result).toMatchObject({
				isError: true,
				content: [{ type: 'text', text: expect.stringContaining('GOOGLE_ADS_CLIENT_ID') }]
			});
		}
	);
});
