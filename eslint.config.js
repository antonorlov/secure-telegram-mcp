// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config.
 *
 * Beyond standard type-aware linting this enforces the CLEAN/HEXAGONAL
 * dependency rule via `no-restricted-imports`: the dependency direction
 * points INWARD (domain -> nothing; application -> domain; infrastructure
 * & presentation -> application/domain). Cross-layer violations and any
 * leak of GramJS types past the infrastructure boundary are hard errors.
 *
 * NOTE: a deeper, path-aware boundary check is provided by the CI denylist
 * guard (scripts/) — this config catches the common cases at edit time.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'scripts/**',
      '**/*.mjs',
      '*.config.js',
      '*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // The npm launcher is plain JavaScript with no type-aware logic.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['bin/**/*.js'],
  },

  // ---- LAYER BOUNDARY: domain depends on NOTHING (no other layer, no GramJS) ----
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/application/**', '**/infrastructure/**', '**/presentation/**', '**/config/**'], message: 'DOMAIN must not depend on outer layers (Clean Architecture: dependencies point inward).' },
            { group: ['telegram', 'telegram/**'], message: 'GramJS must never leak into the domain (only infrastructure may import telegram).' },
          ],
        },
      ],
    },
  },

  // ---- LAYER BOUNDARY: application depends on domain only (not infra/presentation) ----
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**', '**/presentation/**'], message: 'APPLICATION must not depend on infrastructure or presentation — depend on ports (interfaces) instead (DIP).' },
            { group: ['telegram', 'telegram/**'], message: 'GramJS must never leak into the application layer (only infrastructure may import telegram).' },
          ],
        },
      ],
    },
  },

  // ---- LAYER BOUNDARY: infrastructure must not import presentation ----
  // (It legitimately imports src/config — the sealed-policy pipeline — and has
  // its own config/ subdirectory, so no '**/config/**' pattern here.)
  {
    files: ['src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/presentation/**'], message: 'INFRASTRUCTURE must not depend on presentation (Clean Architecture: dependencies point inward).' },
          ],
        },
      ],
    },
  },

  // ---- LAYER BOUNDARY: only infrastructure may import GramJS ----
  // (.tsx included: the Ink setup wizard lives under src/presentation/cli/ink
  // and must never reach GramJS — the encapsulation invariant holds for JSX too.)
  {
    files: [
      'src/presentation/**/*.ts',
      'src/presentation/**/*.tsx',
      'src/config/**/*.ts',
      'src/shared/**/*.ts',
      'demo/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['telegram', 'telegram/**'], message: 'GramJS types must not leak past the infrastructure boundary (Encapsulation invariant).' },
          ],
        },
      ],
    },
  },

  // The tracked onboarding demo may compose the real setup UI, but it must never
  // acquire a production transport or process-spawning capability directly.
  {
    files: ['demo/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:child_process'], message: 'The synthetic demo must not own network or process capabilities.' },
            { group: ['**/presentation/cli/main.js', '**/presentation/mcp/**', '**/presentation/operator/**', '**/daemon-*.js'], message: 'The synthetic demo must enter through runSetup and its injected port only.' },
            { group: ['telegram', 'telegram/**'], message: 'The synthetic demo must never load GramJS.' },
          ],
        },
      ],
    },
  },
);
