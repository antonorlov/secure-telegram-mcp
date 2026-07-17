import type {
  AccountSnapshotDto,
  SessionKeySource,
} from '../../application/index.js';
import { MAX_POLICY_PLAINTEXT_BYTES } from '../../infrastructure/bounded-read.js';

export const OPERATOR_PROTOCOL_VERSION = 1;
/** JSON string escaping can at most double an already-valid policy document. */
export const MAX_OPERATOR_FRAME_BYTES =
  MAX_POLICY_PLAINTEXT_BYTES * 2 + 4096;
const MAX_SECRET_BYTES = 4096;
const MAX_IDENTIFIER_BYTES = 128;

export interface OperatorAccountDto {
  readonly sessionRef: string;
  readonly label?: string;
}

export interface OperatorStatusDto {
  readonly posture: 'none' | 'smooth' | 'hardened';
  readonly locked: boolean;
  readonly hasAccounts: boolean;
}

export type OperatorResult =
  | OperatorStatusDto
  | { readonly accounts: readonly OperatorAccountDto[] }
  | AccountSnapshotDto
  | { readonly authenticated: true }
  | { readonly digest: string }
  | {
      readonly flowId: string;
      readonly account: {
        readonly id: string;
        readonly displayName: string;
        readonly username?: string;
      };
    }
  | { readonly sessionRef: string }
  | { readonly accepted: true }
  | { readonly changed: true };

export type OperatorResponse =
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: true;
      readonly result: OperatorResult;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly event: 'login.qr';
      readonly url: string;
      readonly expiresInSeconds: number;
    }
  | {
      readonly v: 1;
      readonly id: string;
      readonly event: 'login.prompt';
      readonly promptId: string;
      readonly kind: 'phone' | 'code' | 'password';
      readonly hint?: string;
    };

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const boundedString = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= maxBytes;

const parseSource = (
  value: unknown,
): Exclude<SessionKeySource, { readonly kind: 'machine' }> | undefined => {
  const source = recordOf(value);
  if (source === undefined || typeof source['kind'] !== 'string') return undefined;
  if (
    source['kind'] === 'passphrase' &&
    boundedString(source['passphrase'], MAX_SECRET_BYTES) &&
    hasOnly(source, ['kind', 'passphrase'])
  ) {
    return { kind: 'passphrase', passphrase: source['passphrase'] };
  }
  if (
    source['kind'] === 'keyfile' &&
    boundedString(source['keyfilePath'], MAX_SECRET_BYTES) &&
    hasOnly(source, ['kind', 'keyfilePath'])
  ) {
    return { kind: 'keyfile', keyfilePath: source['keyfilePath'] };
  }
  return undefined;
};

const parseAnySource = (value: unknown): SessionKeySource | undefined => {
  const source = recordOf(value);
  return source?.['kind'] === 'machine' && hasOnly(source, ['kind'])
    ? { kind: 'machine' }
    : parseSource(value);
};

type ProtectedSource = Exclude<
  SessionKeySource,
  { readonly kind: 'machine' }
>;

type Request<
  Operation extends string,
  Payload extends object = object,
> = Readonly<{ v: 1; id: string; op: Operation } & Payload>;

export type OperatorRequest =
  | Request<'status'>
  | Request<'accounts.list'>
  | Request<'authenticate', { source: ProtectedSource }>
  | Request<'policy.apply', { raw: string }>
  | Request<'account.snapshot', { sessionRef: string }>
  | Request<
      'login.begin',
      { apiId: number; apiHash: string; method: 'qr' | 'phone' }
    >
  | Request<
      'login.answer',
      { flowId: string; promptId: string; value: string }
    >
  | Request<
      'login.commit',
      { flowId: string; sessionRef: string; source: SessionKeySource }
    >
  | Request<'login.cancel', { flowId: string }>
  | Request<'account.remove', { sessionRef: string }>
  | Request<
      'pin.set',
      { current: { readonly kind: 'machine' }; pin: ProtectedSource }
    >
  | Request<
      'pin.change',
      { current: ProtectedSource; replacement: ProtectedSource }
    >
  | Request<'pin.remove', { current: ProtectedSource }>
  | Request<
      'recovery.export',
      { current: ProtectedSource; outputPath: string }
    >;

/** Return the parsed object only after its operation-specific exact validation. */
const acceptedRequest = (
  value: Record<string, unknown>,
  accepted: boolean,
): OperatorRequest | undefined =>
  accepted ? (value as unknown as OperatorRequest) : undefined;

/** Closed, exact request decoder. Unknown operations and fields are refused. */
export const parseOperatorRequest = (
  line: string,
): OperatorRequest | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const request = recordOf(value);
  if (
    request?.['v'] !== OPERATOR_PROTOCOL_VERSION ||
    typeof request['id'] !== 'string' ||
    request['id'].length === 0 ||
    request['id'].length > 64 ||
    typeof request['op'] !== 'string'
  ) {
    return undefined;
  }
  switch (request['op']) {
    case 'status':
      return acceptedRequest(request, hasOnly(request, ['v', 'id', 'op']));
    case 'accounts.list':
      return acceptedRequest(request, hasOnly(request, ['v', 'id', 'op']));
    case 'authenticate': {
      const source = parseSource(request['source']);
      return acceptedRequest(
        request,
        source !== undefined && hasOnly(request, ['v', 'id', 'op', 'source']),
      );
    }
    case 'policy.apply':
      return acceptedRequest(
        request,
        typeof request['raw'] === 'string' &&
          Buffer.byteLength(request['raw'], 'utf8') <=
            MAX_POLICY_PLAINTEXT_BYTES &&
          hasOnly(request, ['v', 'id', 'op', 'raw']),
      );
    case 'account.snapshot':
      return acceptedRequest(
        request,
        boundedString(request['sessionRef'], MAX_IDENTIFIER_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'sessionRef']),
      );
    case 'login.begin':
      return acceptedRequest(
        request,
        Number.isInteger(request['apiId']) &&
          (request['apiId'] as number) > 0 &&
          (request['apiId'] as number) <= 2_147_483_647 &&
          typeof request['apiHash'] === 'string' &&
          /^[a-f\d]{32}$/i.test(request['apiHash']) &&
          (request['method'] === 'qr' || request['method'] === 'phone') &&
          hasOnly(request, ['v', 'id', 'op', 'apiId', 'apiHash', 'method']),
      );
    case 'login.answer':
      return acceptedRequest(
        request,
        boundedString(request['flowId'], MAX_IDENTIFIER_BYTES) &&
          boundedString(request['promptId'], MAX_IDENTIFIER_BYTES) &&
          boundedString(request['value'], MAX_SECRET_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'flowId', 'promptId', 'value']),
      );
    case 'login.commit': {
      const source = parseAnySource(request['source']);
      return acceptedRequest(
        request,
        source !== undefined &&
          boundedString(request['flowId'], MAX_IDENTIFIER_BYTES) &&
          boundedString(request['sessionRef'], MAX_IDENTIFIER_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'flowId', 'sessionRef', 'source']),
      );
    }
    case 'login.cancel':
      return acceptedRequest(
        request,
        boundedString(request['flowId'], MAX_IDENTIFIER_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'flowId']),
      );
    case 'account.remove':
      return acceptedRequest(
        request,
        boundedString(request['sessionRef'], MAX_IDENTIFIER_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'sessionRef']),
      );
    case 'pin.set': {
      const current = parseAnySource(request['current']);
      const pin = parseSource(request['pin']);
      return acceptedRequest(
        request,
        current?.kind === 'machine' &&
          pin !== undefined &&
          hasOnly(request, ['v', 'id', 'op', 'current', 'pin']),
      );
    }
    case 'pin.change': {
      const current = parseSource(request['current']);
      const replacement = parseSource(request['replacement']);
      return acceptedRequest(
        request,
        current !== undefined &&
          replacement !== undefined &&
          hasOnly(request, ['v', 'id', 'op', 'current', 'replacement']),
      );
    }
    case 'pin.remove': {
      const current = parseSource(request['current']);
      return acceptedRequest(
        request,
        current !== undefined && hasOnly(request, ['v', 'id', 'op', 'current']),
      );
    }
    case 'recovery.export': {
      const current = parseSource(request['current']);
      return acceptedRequest(
        request,
        current !== undefined &&
          boundedString(request['outputPath'], MAX_SECRET_BYTES) &&
          hasOnly(request, ['v', 'id', 'op', 'current', 'outputPath']),
      );
    }
    default:
      return undefined;
  }
};

/** Exhaustive operation policy: adding a request requires choosing its ordering. */
const OPERATOR_OPERATION_IS_SERIAL = Object.freeze({
  status: false,
  'accounts.list': true,
  'account.snapshot': true,
  'login.begin': false,
  'login.answer': false,
  'login.cancel': false,
  authenticate: true,
  'policy.apply': true,
  'login.commit': true,
  'account.remove': true,
  'pin.set': true,
  'pin.change': true,
  'pin.remove': true,
  'recovery.export': true,
} satisfies Record<OperatorRequest['op'], boolean>);

export const OPERATOR_OPERATIONS = Object.freeze(
  Object.keys(OPERATOR_OPERATION_IS_SERIAL) as OperatorRequest['op'][],
);

export const isSerialOperatorOperation = (
  operation: OperatorRequest['op'],
): boolean => OPERATOR_OPERATION_IS_SERIAL[operation];

const boundedText = (value: unknown, maxBytes: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;

const optionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean';

const isAccount = (value: unknown): boolean => {
  const account = recordOf(value);
  return (
    account !== undefined &&
    boundedString(account['sessionRef'], MAX_IDENTIFIER_BYTES) &&
    (account['label'] === undefined || boundedText(account['label'], 16 * 1024)) &&
    hasOnly(account, ['sessionRef', 'label'])
  );
};

const isAccountChat = (value: unknown): boolean => {
  const chat = recordOf(value);
  return (
    chat !== undefined &&
    boundedString(chat['id'], MAX_IDENTIFIER_BYTES) &&
    boundedText(chat['title'], 16 * 1024) &&
    ['user', 'bot', 'group', 'supergroup', 'channel'].includes(
      String(chat['kind']),
    ) &&
    (chat['username'] === undefined ||
      boundedString(chat['username'], MAX_IDENTIFIER_BYTES)) &&
    optionalBoolean(chat['isContact']) &&
    optionalBoolean(chat['isMuted']) &&
    optionalBoolean(chat['isUnread']) &&
    optionalBoolean(chat['isArchived']) &&
    optionalBoolean(chat['hasUnreadMention']) &&
    hasOnly(chat, [
      'id',
      'title',
      'kind',
      'username',
      'isContact',
      'isMuted',
      'isUnread',
      'isArchived',
      'hasUnreadMention',
    ])
  );
};

const FOLDER_FLAG_KEYS = [
  'contacts',
  'nonContacts',
  'groups',
  'broadcasts',
  'bots',
  'excludeMuted',
  'excludeRead',
  'excludeArchived',
] as const;

const isFolderFlags = (value: unknown): boolean => {
  const flags = recordOf(value);
  return (
    flags !== undefined &&
    FOLDER_FLAG_KEYS.every((key) => typeof flags[key] === 'boolean') &&
    hasOnly(flags, FOLDER_FLAG_KEYS)
  );
};

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((entry) => boundedString(entry, MAX_IDENTIFIER_BYTES));

const isAccountFolder = (value: unknown): boolean => {
  const folder = recordOf(value);
  return (
    folder !== undefined &&
    Number.isInteger(folder['id']) &&
    (folder['id'] as number) >= 0 &&
    boundedText(folder['title'], 16 * 1024) &&
    isStringArray(folder['chatIds']) &&
    (folder['excludeChatIds'] === undefined ||
      isStringArray(folder['excludeChatIds'])) &&
    (folder['flags'] === undefined || isFolderFlags(folder['flags'])) &&
    hasOnly(folder, [
      'id',
      'title',
      'chatIds',
      'excludeChatIds',
      'flags',
    ])
  );
};

const isAccountSnapshot = (value: unknown): value is AccountSnapshotDto => {
  const snapshot = recordOf(value);
  return (
    snapshot !== undefined &&
    Array.isArray(snapshot['chats']) &&
    snapshot['chats'].every(isAccountChat) &&
    Array.isArray(snapshot['folders']) &&
    snapshot['folders'].every(isAccountFolder) &&
    hasOnly(snapshot, ['chats', 'folders'])
  );
};

const isOperatorResult = (value: unknown): value is OperatorResult => {
  const result = recordOf(value);
  if (result === undefined) return false;
  if (isAccountSnapshot(result)) return true;
  if (
    (result['posture'] === 'none' ||
      result['posture'] === 'smooth' ||
      result['posture'] === 'hardened') &&
    typeof result['locked'] === 'boolean' &&
    typeof result['hasAccounts'] === 'boolean' &&
    hasOnly(result, ['posture', 'locked', 'hasAccounts'])
  ) {
    return true;
  }
  if (
    Array.isArray(result['accounts']) &&
    result['accounts'].every(isAccount) &&
    hasOnly(result, ['accounts'])
  ) {
    return true;
  }
  if (
    boundedString(result['flowId'], MAX_IDENTIFIER_BYTES) &&
    recordOf(result['account']) !== undefined &&
    boundedString(recordOf(result['account'])?.['id'], MAX_IDENTIFIER_BYTES) &&
    boundedText(recordOf(result['account'])?.['displayName'], 16 * 1024) &&
    (recordOf(result['account'])?.['username'] === undefined ||
      boundedString(
        recordOf(result['account'])?.['username'],
        MAX_IDENTIFIER_BYTES,
      )) &&
    hasOnly(recordOf(result['account']) ?? {}, [
      'id',
      'displayName',
      'username',
    ]) &&
    hasOnly(result, ['flowId', 'account'])
  ) {
    return true;
  }
  return (
    (result['authenticated'] === true && hasOnly(result, ['authenticated'])) ||
    (typeof result['digest'] === 'string' &&
      /^[a-f\d]{64}$/i.test(result['digest']) &&
      hasOnly(result, ['digest'])) ||
    (boundedString(result['sessionRef'], MAX_IDENTIFIER_BYTES) &&
      hasOnly(result, ['sessionRef'])) ||
    (result['accepted'] === true && hasOnly(result, ['accepted'])) ||
    (result['changed'] === true && hasOnly(result, ['changed']))
  );
};

/** Confirm that a success payload belongs to the request it answers. */
export const isOperatorResultFor = (
  operation: OperatorRequest['op'],
  value: OperatorResult,
): boolean => {
  const result = value as Record<string, unknown>;
  switch (operation) {
    case 'status':
      return 'posture' in result;
    case 'accounts.list':
      return 'accounts' in result;
    case 'authenticate':
      return result['authenticated'] === true;
    case 'policy.apply':
      return 'digest' in result;
    case 'account.snapshot':
      return 'chats' in result && 'folders' in result;
    case 'login.begin':
      return 'flowId' in result && 'account' in result;
    case 'login.answer':
    case 'login.cancel':
      return result['accepted'] === true;
    case 'login.commit':
      return 'sessionRef' in result;
    case 'account.remove':
    case 'pin.set':
    case 'pin.change':
    case 'pin.remove':
    case 'recovery.export':
      return result['changed'] === true;
  }
};

/** Closed response decoder used at the setup/daemon trust boundary. */
export const parseOperatorResponse = (
  line: string,
): OperatorResponse | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const response = recordOf(value);
  if (
    response?.['v'] !== OPERATOR_PROTOCOL_VERSION ||
    !boundedText(response['id'], 64)
  ) {
    return undefined;
  }
  if (response['event'] === 'login.qr') {
    return boundedString(response['url'], MAX_SECRET_BYTES) &&
      Number.isInteger(response['expiresInSeconds']) &&
      (response['expiresInSeconds'] as number) >= 0 &&
      hasOnly(response, ['v', 'id', 'event', 'url', 'expiresInSeconds'])
      ? (response as unknown as OperatorResponse)
      : undefined;
  }
  if (response['event'] === 'login.prompt') {
    return boundedString(response['promptId'], MAX_IDENTIFIER_BYTES) &&
      (response['kind'] === 'phone' ||
        response['kind'] === 'code' ||
        response['kind'] === 'password') &&
      (response['hint'] === undefined ||
        boundedText(response['hint'], 16 * 1024)) &&
      hasOnly(response, ['v', 'id', 'event', 'promptId', 'kind', 'hint'])
      ? (response as unknown as OperatorResponse)
      : undefined;
  }
  if (response['ok'] === true) {
    return isOperatorResult(response['result']) &&
      hasOnly(response, ['v', 'id', 'ok', 'result'])
      ? (response as unknown as OperatorResponse)
      : undefined;
  }
  if (response['ok'] === false) {
    return boundedString(response['error'], MAX_SECRET_BYTES) &&
      hasOnly(response, ['v', 'id', 'ok', 'error'])
      ? (response as unknown as OperatorResponse)
      : undefined;
  }
  return undefined;
};
