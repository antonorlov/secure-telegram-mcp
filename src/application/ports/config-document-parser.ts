import type { Result } from '../../shared/index.js';
import type { AppError } from '../errors.js';
import type { LoadedConfiguration } from './config-repository.js';

/** Shared schema, lint, and domain mapping for an already-parsed document. */
export interface ConfigDocumentParser {
  loadFromParsed(json: unknown): Result<LoadedConfiguration, AppError>;
}
