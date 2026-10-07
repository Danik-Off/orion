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

module.exports = [
  { ignores: ['node_modules/', 'dist/', 'build/', 'models/', 'data/', 'voice-check/', 'wake-eval/', 'voice-samples/', 'src/assets/'] },
  js.configs.recommended,
  {
    // Ядро, навыки, скрипты и тесты — Node (CommonJS)
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    // Окно: обычные <script> в одной глобальной области. Что один файл даёт другим — /* exported */,
    // что берёт у других — /* global */ в начале файла
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: browserGlobals },
  },
  {
    // Окно настроек — настоящие ES-модули (import/export), без общих глобальных имён
    files: ['src/renderer/settings/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2024, globals: browserGlobals },
  },
  {
    files: ['src/renderer/mic-worklet.js'],
    languageOptions: { globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', sampleRate: 'readonly' } },
  },
  prettier,
];
