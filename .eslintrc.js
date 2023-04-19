module.exports = {
  'env': {
    'browser': true,
    'es2021': true
  },
  'extends': [
    'plugin:@typescript-eslint/recommended'
  ],
  'overrides': [
  ],
  'parser': '@typescript-eslint/parser',
  'parserOptions': {
    'ecmaVersion': 'latest',
    'sourceType': 'module'
  },
  'plugins': [
    '@typescript-eslint',
    'simple-import-sort',
    'import'
  ],
  'rules': {
    'simple-import-sort/imports': [
      'error',
      {
        // The default grouping, but with type imports first in each group.
        groups: [
          ['^\\u0000'],
          ['^node:.*\\u0000$', '^node:'],
          ['^@?\\w.*\\u0000$', '^@?\\w'],
          ['(?<=\\u0000)$', '^'],
          ['^\\..*\\u0000$', '^\\.'],
        ],
      },
    ],
    'simple-import-sort/exports': 2,
    'import/first': 2,
    'import/newline-after-import': 2,
    'import/no-duplicates': 2,
    'indent': [2, 2, { 'SwitchCase': 1 }],
    'no-trailing-spaces': 2,
    'eol-last': 2,
    'quotes': [2, 'single', { 'avoidEscape': true }],
    'brace-style': [2, '1tbs'],
    'eqeqeq': [
      2,
      'smart'
    ],
    'prefer-rest-params': 'off',
    'no-console': 2,
    'no-shadow': 'off',
    'arrow-parens': [2, 'as-needed'],
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/ban-types': 'off',
    '@typescript-eslint/no-this-alias': 'off',
  }
}
