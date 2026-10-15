/**
 * Generates TypeScript types for the Google Ads REST API from Google's discovery document.
 *
 *   pnpm codegen
 *
 * The discovery document describes the REST surface exactly as it goes over the wire (camelCase fields,
 * int64 as strings, enums as strings), so the types match real responses, unlike protobuf-generated ones.
 * The discovery revision changes daily without schema changes, so it is not written into the output.
 * Output: src/types/<category>.gen.ts (types only, erased at build time) and src/gaql-resources.gen.ts.
 */
import { writeFileSync } from 'node:fs';
import { GOOGLE_ADS_API_VERSION } from '../src/api-version.ts';

interface Schema {
	id?: string;
	type?: string;
	format?: string;
	description?: string;
	$ref?: string;
	enum?: string[];
	items?: Schema;
	properties?: Record<string, Schema>;
	additionalProperties?: Schema;
	readOnly?: boolean;
}

interface DiscoveryDocument {
	version: string;
	revision: string;
	schemas: Record<string, Schema>;
}

const VERSION = GOOGLE_ADS_API_VERSION;
const DISCOVERY_URL = `https://googleads.googleapis.com/$discovery/rest?version=${VERSION}`;
const OUT_DIR = new URL('../src/types/', import.meta.url);

/** Output modules. Google's own wrapper types (google.rpc.Status, ...) share one module. */
const CATEGORIES = ['resources', 'common', 'services', 'errors', 'actions', 'google'] as const;
type Category = (typeof CATEGORIES)[number];

const res = await fetch(DISCOVERY_URL);
if (!res.ok) throw new Error(`GET ${DISCOVERY_URL} failed: ${res.status} ${res.statusText}`);
const doc = (await res.json()) as DiscoveryDocument;

/** `GoogleAdsGoogleadsV26Resources__AdGroup` → resources.AdGroup, `..Resources_AdGroup_AudienceSetting` → resources.AdGroup_AudienceSetting. */
function locate(schemaId: string): { category: Category; name: string } {
	const prefix = `GoogleAdsGoogleads${VERSION[0]!.toUpperCase()}${VERSION.slice(1)}`;
	if (schemaId.startsWith(prefix)) {
		const rest = schemaId.slice(prefix.length);
		const match = /^(Resources|Common|Services|Errors|Actions)_{1,2}(.+)$/.exec(rest);
		if (!match) throw new Error(`Unexpected schema id: ${schemaId}`);
		return { category: match[1]!.toLowerCase() as Category, name: match[2]! };
	}
	// GoogleRpc__Status → Rpc_Status, GoogleProtobuf__Empty → Protobuf_Empty, ...
	return { category: 'google', name: schemaId.replace(/^Google/, '').replace('__', '_') };
}

function jsDoc(schema: Schema, indent: string): string {
	const lines: string[] = [];
	const text = firstSentence(schema.description);
	if (text) lines.push(text);
	if (schema.format === 'int64' || schema.format === 'uint64')
		lines.push('int64, sent as a string.');
	if (!lines.length) return '';
	const body = lines.join(' ').replaceAll('*/', '*\\/');
	return `${indent}/** ${body} */\n`;
}

/**
 * Field behaviour markers ("Immutable.", "Required.") plus the first real sentence.
 * "Output only." is dropped because `readonly` already says it.
 */
function firstSentence(description: string | undefined): string {
	if (!description) return '';
	let rest = description.replace(/\s+/g, ' ').trim();
	const markers: string[] = [];
	for (;;) {
		const marker = /^(Output only|Immutable|Required|Optional)\. ?/.exec(rest);
		if (!marker) break;
		if (marker[1] !== 'Output only') markers.push(`${marker[1]}.`);
		rest = rest.slice(marker[0].length);
	}
	const end = rest.search(/\.(\s|$)/);
	const sentence = end === -1 ? rest : rest.slice(0, end + 1);
	return [...markers, sentence].filter(Boolean).join(' ');
}

function typeOf(schema: Schema, from: Category, imports: Set<Category>): string {
	if (schema.$ref) {
		const { category, name } = locate(schema.$ref);
		if (category === from) return name;
		imports.add(category);
		return `${category}.${name}`;
	}
	if (schema.enum) return schema.enum.map((value) => `'${value}'`).join(' | ');
	switch (schema.type) {
		case 'string':
			return 'string';
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'array':
			return `Array<${typeOf(schema.items ?? {}, from, imports)}>`;
		case 'object':
			if (schema.properties) return inlineObject(schema, from, imports);
			return schema.additionalProperties
				? `Record<string, ${typeOf(schema.additionalProperties, from, imports)}>`
				: 'Record<string, unknown>';
		case 'any':
		default:
			return 'unknown';
	}
}

function inlineObject(schema: Schema, from: Category, imports: Set<Category>): string {
	const fields = sortedProperties(schema).map(
		([key, prop]) =>
			`${prop.readOnly ? 'readonly ' : ''}${propName(key)}?: ${typeOf(prop, from, imports)}`
	);
	return `{ ${fields.join('; ')} }`;
}

/** Alphabetical, so a reordered discovery document does not produce a diff. */
function sortedProperties(schema: Schema): Array<[string, Schema]> {
	return Object.entries(schema.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

function propName(key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`;
}

const modules = new Map<Category, { body: string[]; imports: Set<Category> }>(
	CATEGORIES.map((category) => [category, { body: [], imports: new Set() }])
);

for (const [id, schema] of Object.entries(doc.schemas).sort(([a], [b]) => a.localeCompare(b))) {
	const { category, name } = locate(id);
	const mod = modules.get(category)!;
	let out = jsDoc(schema, '');
	if (schema.type === 'object' || schema.properties) {
		out += `export interface ${name} {\n`;
		for (const [key, prop] of sortedProperties(schema)) {
			out += jsDoc(prop, '\t');
			out += `\t${prop.readOnly ? 'readonly ' : ''}${propName(key)}?: ${typeOf(prop, category, mod.imports)};\n`;
		}
		out += '}\n';
	} else {
		out += `export type ${name} = ${typeOf(schema, category, mod.imports)};\n`;
	}
	mod.body.push(out);
}

const header = (category: Category, imports: Set<Category>) =>
	[
		`// Generated by scripts/codegen.ts from the Google Ads API ${VERSION} discovery document.`,
		'// Do not edit; run `pnpm codegen`.',
		'',
		...[...imports]
			.filter((other) => other !== category)
			.sort()
			.map((other) => `import type * as ${other} from './${other}.gen.ts';`),
		''
	].join('\n');

for (const [category, { body, imports }] of modules) {
	writeFileSync(
		new URL(`${category}.gen.ts`, OUT_DIR),
		`${header(category, imports)}\n${body.join('\n')}`
	);
}

// GAQL resources = fields of GoogleAdsRow that hold a resource, in snake_case (`ad_group_criterion`).
const rowId = Object.keys(doc.schemas).find((id) => locate(id).name === 'GoogleAdsRow')!;
const resourceNames = Object.entries(doc.schemas[rowId]!.properties ?? {})
	.filter(([, prop]) => prop.$ref && locate(prop.$ref).category === 'resources')
	.map(([key]) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
	.sort();
writeFileSync(
	new URL('../src/gaql-resources.gen.ts', import.meta.url),
	[
		`// Generated by scripts/codegen.ts from the Google Ads API ${VERSION} discovery document.`,
		'// Do not edit; run `pnpm codegen`.',
		'',
		'/** Every resource that can follow FROM in a GAQL query. */',
		`export const GAQL_RESOURCES = [\n${resourceNames.map((name) => `\t'${name}'`).join(',\n')}\n] as const;`,
		'',
		'export type GaqlResource = (typeof GAQL_RESOURCES)[number];',
		''
	].join('\n')
);

console.log(
	`Generated ${Object.keys(doc.schemas).length} schemas and ${resourceNames.length} GAQL resources for ${VERSION} (revision ${doc.revision}).`
);
