import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'

const jsFiles = ['**/*.{js,mjs,cjs}']

export default [
  // Stylistic formatting rules
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: false,
    jsx: false,
    commaDangle: 'never',
    braceStyle: '1tbs'
  }),
  {
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      '@stylistic/space-before-function-paren': ['error', 'always']
    }
  },
  {
    ...js.configs.recommended,
    files: jsFiles
  },
  {
    files: jsFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  // Service Worker specific config
  {
    files: ['**/sw.js', '**/service-worker.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^e$' }]
    }
  },
  // Scaffolds: disable rules that flag intentional bugs
  {
    files: ['scaffolds/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      'no-fallthrough': 'off',
      'no-empty': 'off',
      '@stylistic/no-mixed-operators': 'off'
    }
  },
  {
    ignores: ['node_modules/**', 'dist/**', 'dist-student/**', 'course/public/**', '**/*.html']
  }
]
