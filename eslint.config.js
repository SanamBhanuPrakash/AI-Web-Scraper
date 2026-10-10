import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '.claude/**',
      'apps/web/src/sample.json',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      // Security: never build code from strings.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // Backend: Node
  {
    files: ['apps/api/**/*.ts', 'api/**/*.ts', 'scripts/**/*.mjs', 'packages/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Plain browser script served as-is (theme-init.js)
  {
    files: ['apps/web/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },

  // Frontend: browser, React hooks, accessibility
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      'no-restricted-syntax': [
        'error',
        // XSS: summaries and page text are rendered as React text, never as HTML.
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Never inject HTML. Render text through React.',
        },
      ],
    },
  },

  // Tests and fixtures may be looser
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**', 'apps/web/e2e/**', 'apps/api/scripts/**'],
    rules: {
      'require-yield': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
