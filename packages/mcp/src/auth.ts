/**
 * One-time Google sign-in that saves GOOGLE_ADS_REFRESH_TOKEN to an env file.
 *
 * Needs a "Desktop app" OAuth client (Google Cloud Console → Google Auth Platform → Clients).
 * Uses the loopback flow with PKCE: opens the consent page, catches the redirect on 127.0.0.1,
 * exchanges the code, then checks the token by listing accessible Google Ads accounts.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleAdsClient } from '@adginr/google-ads-rest';

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const TIMEOUT_MS = 5 * 60_000;

export interface AuthOptions {
	/** Env file to read the client from and write the refresh token to. */
	envFile: string;
	/** Optional "Download JSON" client file whose ID/secret are copied into the env file first. */
	clientFile?: string;
}

export async function runAuth({ envFile, clientFile }: AuthOptions): Promise<void> {
	if (clientFile) importClientFile(clientFile, envFile);

	const { GOOGLE_ADS_CLIENT_ID: clientId, GOOGLE_ADS_CLIENT_SECRET: clientSecret } = process.env;
	if (!clientId || !clientSecret) {
		throw new Error(
			`Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET in ${envFile}, or pass the downloaded client JSON:\n` +
				'  google-ads-mcp auth ~/Downloads/client_secret_….json\n' +
				'Create the client at https://console.cloud.google.com/auth/clients (type: Desktop app).'
		);
	}

	const base64url = (bytes: Buffer) => bytes.toString('base64url');
	const verifier = base64url(randomBytes(32));
	const state = base64url(randomBytes(16));

	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	authUrl.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: SCOPE,
		access_type: 'offline',
		prompt: 'consent', // always return a refresh token, even on repeat runs
		state,
		code_challenge: base64url(createHash('sha256').update(verifier).digest()),
		code_challenge_method: 'S256'
	}).toString();

	console.log(`Opening Google sign-in. If no browser opens, visit:\n\n${authUrl}\n`);
	openBrowser(authUrl.toString());

	let code: string;
	try {
		code = await waitForCode(server, redirectUri, state);
	} finally {
		server.close();
	}

	const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			client_secret: clientSecret,
			redirect_uri: redirectUri,
			code_verifier: verifier
		})
	});
	const tokens = (await tokenRes.json()) as {
		refresh_token?: string;
		error?: string;
		error_description?: string;
	};
	if (!tokenRes.ok || !tokens.refresh_token) {
		throw new Error(
			`Token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.statusText}`
		);
	}

	upsertEnv(envFile, 'GOOGLE_ADS_REFRESH_TOKEN', tokens.refresh_token);
	console.log(`✓ Saved GOOGLE_ADS_REFRESH_TOKEN to ${envFile}`);

	const ads = new GoogleAdsClient({
		clientId,
		clientSecret,
		refreshToken: tokens.refresh_token,
		loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
	});
	const customers = await ads.listAccessibleCustomers();
	console.log(`✓ Google Ads API works. Accessible accounts (${customers.length}):`);
	for (const name of customers) console.log(`  ${name.replace('customers/', '')}`);
}

function waitForCode(server: Server, redirectUri: string, state: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Timed out waiting for sign-in.')), TIMEOUT_MS);
		server.on('request', (req, res) => {
			const url = new URL(req.url ?? '/', redirectUri);
			if (url.pathname !== '/') return void res.writeHead(404).end();

			const error = url.searchParams.get('error');
			const received = url.searchParams.get('code');
			const ok = !error && received && url.searchParams.get('state') === state;
			res
				.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
				.end(ok ? 'Done. You can close this tab.' : `Sign-in failed: ${error ?? 'bad state'}`);

			clearTimeout(timer);
			if (ok) resolve(received);
			else reject(new Error(`Sign-in failed: ${error ?? 'state mismatch'}`));
		});
	});
}

/** Copies client_id/secret from a Google "Download JSON" file into the env file and process.env. */
function importClientFile(path: string, envFile: string) {
	const json = JSON.parse(readFileSync(path, 'utf8'));
	const client = json.installed;
	if (!client?.client_id || !client?.client_secret) {
		throw new Error(
			Object.keys(json)[0] === 'web'
				? 'This is a "Web application" client; create a "Desktop app" client instead.'
				: `Not a Google OAuth client file: ${path}`
		);
	}
	for (const [key, value] of [
		['GOOGLE_ADS_CLIENT_ID', client.client_id],
		['GOOGLE_ADS_CLIENT_SECRET', client.client_secret]
	] as const) {
		upsertEnv(envFile, key, value);
		process.env[key] = value;
	}
	console.log(`✓ Saved client ID/secret from ${path} to ${envFile}`);
}

export function upsertEnv(envFile: string, key: string, value: string) {
	const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
	const line = `${key}=${value}`;
	const pattern = new RegExp(`^${key}=.*$`, 'm');
	const next = pattern.test(text)
		? text.replace(pattern, line)
		: `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
	writeFileSync(envFile, next, { mode: 0o600 });
}

function openBrowser(url: string) {
	const [cmd, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '', url]]
				: ['xdg-open', [url]];
	spawn(cmd, args, { stdio: 'ignore', detached: true })
		.on('error', () => {})
		.unref();
}
