// Flat ESLint config for this project's TS + React setup — `npm run check:lint` (`eslint src`).
//
// KNOWN BLOCKER, read before assuming this is broken by accident:
//
// As of this writing, `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin`
// (both pinned to ^8.67.0) refuse to load at all against this project's installed
// `typescript` (^7.0.2, the new native/Go-rewrite compiler with a different internal
// API surface — see `node_modules/typescript/package.json`'s `exports`, all
// `./unstable/*` entry points, no classic Program/Checker JS API). Both packages
// throw synchronously at `require()` time:
//
//   typescript-eslint does not support TS 7.0.
//   https://github.com/typescript-eslint/typescript-eslint/issues/10940
//
// This is not something a config file can route around — the throw happens before
// any rule, parserOptions, or file pattern is ever consulted, so `eslint src` fails
// immediately regardless of what this file says. Confirmed directly:
//
//   node -e "require('@typescript-eslint/parser')"       → throws the message above
//   node -e "require('@typescript-eslint/eslint-plugin')" → same
//
// The config below is still written the normal, correct way — parser + plugin
// wired up exactly as this project's TS + React setup calls for — so it starts
// working the moment either side of the version mismatch is resolved (a
// typescript-eslint release that supports TS 7, per the tracking issue above, or
// this project pinning `typescript` back to a 6.x line for lint purposes). Until
// then `npm run check:lint` fails at the `require()`, and that failure is the
// accurate signal, not a bug in this file.
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'android/**',
      'release/**',
      'node_modules/**',
      'tests/**', // its own dependency island — see tests/playwright.config.ts's module doc
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
        // No `project`: this is syntax-aware linting, not type-aware. Type-aware
        // rules need a full `tsc` program per file and are a lot more to police
        // for a first pass — see the module doc for "do not mass-fix unrelated
        // code". Nothing below needs type information anyway.
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      // The two rules this config exists to enforce, per project convention:
      // hooks called conditionally/in loops, or effects with a stale/missing
      // dependency, are both bug classes this codebase has hit before and both
      // are cheap to catch mechanically. Both are errors, not warnings — a
      // violation is either a real bug or the rule needs a documented
      // `// eslint-disable-next-line` at the call site, never a silent pass.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]
