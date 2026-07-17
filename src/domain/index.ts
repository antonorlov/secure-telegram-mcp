/** Domain public surface — outer layers import the domain through this barrel. */

export { DomainErrorCode, domainError } from './errors.js';
export type { DomainError } from './errors.js';

export {
  PermissionVerb,
  ALL_PERMISSION_VERBS,
  isReadVerb,
  isWriteVerb,
  isPermissionVerb,
} from './value-objects/permission-verb.js';
export { ChatId } from './value-objects/chat-id.js';
export { GENERAL_TOPIC_ID } from './value-objects/topic-id.js';
export { PeerRefFactory } from './value-objects/peer-ref.js';
export type { PeerRef } from './value-objects/peer-ref.js';
export { FolderRefFactory } from './value-objects/folder-ref.js';
export type { FolderRef } from './value-objects/folder-ref.js';
export { EndpointName, SessionRef, SLUG_RE, isSlug } from './value-objects/identifiers.js';
export type { EndpointNameValue, SessionRefValue } from './value-objects/identifiers.js';
export { Scope } from './value-objects/scope.js';
export { ResolvedScope } from './value-objects/resolved-scope.js';
export { AclDecisionFactory } from './value-objects/acl-decision.js';
export type { AclDecision } from './value-objects/acl-decision.js';
export {
  UntrustedText,
  UntrustedTextKind,
} from './value-objects/untrusted-text.js';

export { Endpoint, DEFAULT_CONFIRM_WRITES } from './entities/endpoint.js';
export type { DeclaredChatVerbOverride } from './entities/endpoint.js';

export type {
  AclEvaluationInput,
} from './services/acl-evaluator.js';
export { DefaultAclEvaluator } from './services/default-acl-evaluator.js';
export {
  effectiveVerbPermits,
  chatOverridePermitsVerb,
} from './services/effective-verb-resolver.js';
export type { ChatVerbOverrideTable } from './services/effective-verb-resolver.js';
