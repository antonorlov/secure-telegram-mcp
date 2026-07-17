/**
 * Endpoint — "what this MCP endpoint may do", keyed by EndpointName. The one
 * aggregate root: binds the DECLARED scope (folders not yet resolved), the
 * granted verb set (default-deny — what the execution-time ACL consults),
 * the declared per-chat verb overrides, the SessionRef it authenticates with,
 * and the write-confirmation (HITL) flag. Peer-membership is enforced
 * separately by the ACL evaluator against the ResolvedScope.
 */
import { uniqueFrozen } from '../../shared/index.js';
import type {
  EndpointNameValue,
  SessionRefValue,
} from '../value-objects/identifiers.js';
import {
  isWriteVerb,
  type PermissionVerb,
} from '../value-objects/permission-verb.js';
import type { Scope } from '../value-objects/scope.js';
import type { PeerRef } from '../value-objects/peer-ref.js';

/**
 * Write-confirmation default when an endpoint does not specify one: OFF
 * (opt-in). Imported by the config schema and setup wizard as the shared default.
 */
export const DEFAULT_CONFIRM_WRITES = false;

/**
 * A DECLARED per-chat verb override as authored in config: an unresolved
 * `PeerRef` paired with the verbs that REPLACE the endpoint default for that
 * chat. The runtime resolves username/me peers to ids and builds the keyed
 * `ChatVerbOverrideTable` the ACL evaluator consumes (mirroring Scope ->
 * ResolvedScope).
 */
export interface DeclaredChatVerbOverride {
  readonly peer: PeerRef;
  readonly verbs: readonly PermissionVerb[];
}

export class Endpoint {
  public readonly name: EndpointNameValue;
  /** The DECLARED scope (folders not yet resolved to canonical ids). */
  public readonly scope: Scope;
  public readonly sessionRef: SessionRefValue;
  /**
   * HITL flag: writes require human confirmation when true. Read verbs are
   * never gated; per-endpoint, defaults to OFF (`DEFAULT_CONFIRM_WRITES`).
   */
  public readonly confirmWrites: boolean;
  /** Salted digest of the endpoint API key; authorization data, never key material. */
  public readonly tokenHash: string;
  private readonly grantedVerbSet: ReadonlySet<PermissionVerb>;
  private readonly chatOverrides: readonly DeclaredChatVerbOverride[];

  private constructor(
    name: EndpointNameValue,
    scope: Scope,
    grantedVerbSet: ReadonlySet<PermissionVerb>,
    chatOverrides: readonly DeclaredChatVerbOverride[],
    sessionRef: SessionRefValue,
    confirmWrites: boolean,
    tokenHash: string,
  ) {
    this.name = name;
    this.scope = scope;
    this.grantedVerbSet = grantedVerbSet;
    this.chatOverrides = chatOverrides;
    this.sessionRef = sessionRef;
    this.confirmWrites = confirmWrites;
    this.tokenHash = tokenHash;
    Object.freeze(this);
  }

  public static create(params: {
    readonly name: EndpointNameValue;
    readonly scope: Scope;
    readonly verbs: readonly PermissionVerb[];
    readonly chatOverrides?: readonly DeclaredChatVerbOverride[];
    readonly sessionRef: SessionRefValue;
    readonly confirmWrites: boolean;
    readonly tokenHash: string;
  }): Endpoint {
    return new Endpoint(
      params.name,
      params.scope,
      new Set(uniqueFrozen(params.verbs)),
      Object.freeze(
        (params.chatOverrides ?? []).map((o) => ({
          peer: o.peer,
          verbs: uniqueFrozen(o.verbs),
        })),
      ),
      params.sessionRef,
      params.confirmWrites,
      params.tokenHash,
    );
  }

  /** A verb is permitted only if this endpoint grants it (default-deny). */
  public permits(verb: PermissionVerb): boolean {
    return this.grantedVerbSet.has(verb);
  }

  /**
   * The DECLARED per-chat verb overrides (unresolved); empty for the common
   * case. The runtime resolves these to the keyed `ChatVerbOverrideTable`.
   */
  public overrides(): readonly DeclaredChatVerbOverride[] {
    return this.chatOverrides;
  }

  /** Whether a verb requires human confirmation before execution. */
  public requiresConfirmation(verb: PermissionVerb): boolean {
    return this.confirmWrites && isWriteVerb(verb);
  }
}
