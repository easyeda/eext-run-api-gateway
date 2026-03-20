import antfu from '@antfu/eslint-config';

export default antfu({
	stylistic: {
		indent: 'tab',
		quotes: 'single',
		semi: true,
	},

	typescript: true,

	ignores: ['AGENTS.md', 'build/dist/', 'coverage/', 'dist/', 'node_modules/', '.eslintcache', 'debug.log'],
});
