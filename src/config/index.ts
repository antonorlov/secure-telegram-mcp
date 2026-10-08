export {
  chatEntryToRef,
  configSchema,
  folderEntryValue,
  parseChatRef,
} from './schema.js';
export type {
  ValidatedConfig,
  ValidatedEndpoint,
  ValidatedScope,
} from './schema.js';
export { lintConfig, hasLintErrors } from './scope-lint.js';
export type { LintFinding } from './scope-lint.js';
export { mapConfigToDomain } from './mapper.js';
export type { MappedConfig } from './mapper.js';
