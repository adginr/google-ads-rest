#!/usr/bin/env node
/**
 *   google-ads-mcp                    MCP server over stdio (what MCP clients launch)
 *   google-ads-mcp --http [--port N]  Streamable HTTP on http://127.0.0.1:N/mcp (localhost only, no auth)
 *   google-ads-mcp --read-only        only tools that never change the account
 *   google-ads-mcp auth [client.json] one-time Google sign-in, writes GOOGLE_ADS_REFRESH_TOKEN to .env
 *
 * Configuration comes from GOOGLE_ADS_* environment variables, plus `.env` in the working directory
 * (or the file in GOOGLE_ADS_ENV_FILE) when present. Real environment variables win.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GoogleAdsClient } from '@adginr/google-ads-rest';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
	createMcpHandler,
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import pkg from '../package.json' with { type: 'json' };
import { runAuth } from './auth.ts';
import { createGoogleAdsMcpServer } from './server.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		http: { type: 'boolean', default: false },
		port: { type: 'string', default: '8765' },
		'read-only': { type: 'boolean', default: false },
		'env-file': { type: 'string' },
		version: { type: 'boolean', short: 'v', default: false },
		help: { type: 'boolean', short: 'h', default: false }
	}
});

const HELP = `google-ads-mcp ${pkg.version}: Google Ads MCP server over the REST API

Usage:
  google-ads-mcp                     serve over stdio (for Claude Code, Claude Desktop, Cursor, ...)
  google-ads-mcp --http [--port N]   serve Streamable HTTP on http://127.0.0.1:N/mcp (default 8765)
  google-ads-mcp auth [client.json]  sign in with Google and save GOOGLE_ADS_REFRESH_TOKEN

Options:
  --read-only        expose only tools that never change the account
  --env-file <path>  env file to load and to write on auth (default: ./.env)
  -v, --version      print the version
  -h, --help         show this help

Environment:
  GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN (required)
  GOOGLE_ADS_LOGIN_CUSTOMER_ID (manager account, optional)
  GOOGLE_ADS_MCP_READ_ONLY=1 (same as --read-only)
`;

if (values.help) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (values.version) {
	process.stdout.write(`${pkg.version}\n`);
	process.exit(0);
}

const envFile = resolve(values['env-file'] ?? process.env.GOOGLE_ADS_ENV_FILE ?? '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const command = positionals[0];
try {
	if (command === 'auth') {
		await runAuth({ envFile, clientFile: positionals[1] });
	} else if (command === undefined || command === 'serve') {
		await serve();
	} else {
		process.stderr.write(`Unknown command '${command}'.\n\n${HELP}`);
		process.exit(2);
	}
} catch (error) {
	process.stderr.write(`${(error as Error).message}\n`);
	process.exit(1);
}

async function serve() {
	const ads = GoogleAdsClient.fromEnv();
	const readOnly = values['read-only'] || process.env.GOOGLE_ADS_MCP_READ_ONLY === '1';
	const factory = () => createGoogleAdsMcpServer({ ads, readOnly });

	if (!values.http) {
		// stdout is the protocol channel: log to stderr only.
		serveStdio(factory, { onerror: (error) => process.stderr.write(`${error.message}\n`) });
		return;
	}

	const port = Number(values.port);
	const handler = createMcpHandler(factory);
	const node = toNodeHandler({
		// No auth on this transport: only answer localhost (also blocks DNS rebinding from browsers).
		fetch: async (request) =>
			hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
			originValidationResponse(request, localhostAllowedOrigins()) ??
			handler.fetch(request)
	});
	const server = createServer((req, res) => {
		if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
			res.writeHead(404).end('Not found. The MCP endpoint is /mcp.');
			return;
		}
		void node(req, res);
	});
	server.listen(port, '127.0.0.1', () => {
		process.stderr.write(
			`google-ads-mcp ${pkg.version}${readOnly ? ' (read-only)' : ''} listening on http://127.0.0.1:${port}/mcp\n`
		);
	});
}
