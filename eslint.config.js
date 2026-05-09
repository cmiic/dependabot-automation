import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const jsFiles = ['**/*.{js,mjs,cjs}']
const tsFiles = ['**/*.ts']

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
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: tsFiles
  })),
  {
    files: [...jsFiles, ...tsFiles],
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
    files: ['**/sw.js', '**/service-worker.js', '**/sw.ts', '**/service-worker.ts'],
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
