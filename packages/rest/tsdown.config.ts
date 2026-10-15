import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/tools/index.ts'],
	format: 'esm',
	platform: 'node',
	target: 'node22',
	dts: true,
	unbundle: true,
	clean: true,
	// .js / .d.ts, matching "type": "module" and the exports map.
	fixedExtension: false
});
