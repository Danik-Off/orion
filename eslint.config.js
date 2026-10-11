// Линтер: npm run lint (исправить, что можно, — npm run lint -- --fix). Оформление — Prettier (npm run format),
// поэтому здесь только правила о смысле кода, без стиля.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

// window.name не нужен окну, а имя «name» занято под имя ассистента
const { name: _windowName, ...browserGlobals } = globals.browser;

const rules = {
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }], // «попробовать и не страшно» — частый приём: файл может не существовать
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-throw-literal': 'error',
  'no-return-await': 'error',
  'no-useless-concat': 'error',
  'object-shorthand': 'error',
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'functions' }],
};

const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'build/', 'models/', 'data/', 'voice-check/', 'wake-eval/', 'src/assets/', 'src/ui/dist/'] },
  js.configs.recommended,
  {
    // Ядро, навыки, скрипты и тесты — Node (CommonJS)
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    files: ['src/ui/public/mic-worklet.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' },
    },
  },
  // Окна — TypeScript и React (src/ui): типы проверяет tsc (npm run ui:check), здесь — смысл кода и правила хуков
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['src/ui/**/*.{ts,tsx}'] })),
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: browserGlobals },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  prettier,
];
