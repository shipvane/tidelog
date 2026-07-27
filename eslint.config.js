'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
];
