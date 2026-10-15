/** @type {import("prettier").Config} */
export default {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100,
	overrides: [{ files: ['*.yml', '*.yaml', '*.md'], options: { useTabs: false } }]
};
