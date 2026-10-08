/**
 * The one aggregate root: declared scope, granted verbs (default-deny), declared per-chat
 * overrides, the session ref it authenticates with and the HITL flag. Peer membership is
 * enforced separately, by the ACL evaluator against the ResolvedScope.
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

// Shared default, imported by the config schema and the setup wizard.
export const DEFAULT_CONFIRM_WRITES = false;

// Verbs that REPLACE the endpoint default for one chat. The runtime resolves the peer to an id
// and builds the keyed table the ACL evaluator consumes.
export interface DeclaredChatVerbOverride {
  readonly peer: PeerRef;
  readonly verbs: readonly PermissionVerb[];
}

export class Endpoint {
  public readonly name: EndpointNameValue;
  public readonly scope: Scope;
  public readonly sessionRef: SessionRefValue;
  // Read verbs are never gated; per-endpoint, defaults to off.
  public readonly confirmWrites: boolean;
  // Salted digest of the endpoint API key — authorization data, never key material.
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

  public permits(verb: PermissionVerb): boolean {
    return this.grantedVerbSet.has(verb);
  }

  public overrides(): readonly DeclaredChatVerbOverride[] {
    return this.chatOverrides;
  }

  public requiresConfirmation(verb: PermissionVerb): boolean {
    return this.confirmWrites && isWriteVerb(verb);
  }
}
