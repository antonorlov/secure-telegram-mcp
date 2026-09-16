import type {
  ChatVerbOverrideTable,
  DeclaredChatVerbOverride,
  Endpoint,
  ResolvedScope,
  Scope,
  SessionRefValue,
} from '../../domain/index.js';

export interface ResolveScopeInput {
  readonly sessionRef: SessionRefValue;
  readonly scope: Scope;
  readonly overrides: readonly DeclaredChatVerbOverride[];
}

// Scope and overrides resolved together so their canonical identifiers cannot drift.
export interface ResolvedAccess {
  readonly scope: ResolvedScope;
  readonly overrides: ChatVerbOverrideTable;
}

export interface BindScopedClientInput {
  readonly endpoint: Endpoint;
  readonly resolvedScope: ResolvedScope;
  readonly overrides: ChatVerbOverrideTable;
  readonly maxDownloadBytes?: number;
}
