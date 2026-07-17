/** Application public surface — use-cases + ports. Depends only on domain + shared. */

export { AppErrorCode, appError, validationError } from './errors.js';
export type { AppError } from './errors.js';

export type { Clock } from './ports/clock.js';
export type { ScopedClient } from './ports/scoped-client.js';
export type {
  BindScopedClientInput,
  ResolveScopeInput,
  ResolvedAccess,
} from './dtos/endpoint-access.js';
export type { SessionMaterial } from './dtos/session-material.js';
export type { SessionKeySource } from './ports/session-key-source.js';
export type {
  SessionAdmin,
  SessionSecurityAdmin,
  AddKekInput,
  RewrapKekInput,
  RemoveKekInput,
  EmitRecoveryKeyfileInput,
} from './ports/session-admin.js';
export type {
  ConfigRepository,
  LoadedConfiguration,
  KillSwitch,
} from './ports/config-repository.js';
export type { RuntimeUnlockableStore } from './ports/session-unlock.js';
export type { ConfigDocumentParser } from './ports/config-document-parser.js';
export type { SealedPolicyStore } from './ports/sealed-policy-store.js';
export type { AuditLog, AuditRecord } from './ports/audit-log.js';
export { QuotaBucket } from './ports/rate-limiter.js';
export type { RateLimiter, ConsumeQuotaInput } from './ports/rate-limiter.js';
export type { Confirmer, ConfirmationRequest } from './ports/confirmer.js';

export type { Page } from './dtos/pagination.js';
export type {
  MediaKind,
  MediaInfoDto,
  MessageDto,
  MessageReactionDto,
  MediaFileDto,
} from './dtos/messages.js';
export type {
  ChatKind,
  DialogDto,
  ChatInfoDto,
  ParticipantDto,
} from './dtos/dialogs.js';
export type { TopicDto } from './dtos/topics.js';
export type {
  AccountChatDto,
  AccountFolderFlagsDto,
  AccountFolderDto,
  AccountSnapshotDto,
} from './dtos/account-snapshot.js';
export type {
  SendResultDto,
  EditResultDto,
  DeleteResultDto,
  DraftResultDto,
  MarkReadResultDto,
  ForwardResultDto,
  ReactionResultDto,
  MediaHandleDto,
} from './dtos/results.js';
export type {
  GetMessagesQuery,
  SearchMessagesQuery,
  ListDialogsQuery,
  ListTopicsQuery,
  GetChatInfoQuery,
  GetMediaInfoQuery,
  DownloadMediaQuery,
  GetPinnedQuery,
  ListParticipantsQuery,
  SendMessageCommand,
  EditMessageCommand,
  DeleteMessageCommand,
  SaveDraftCommand,
  MarkReadCommand,
  ForwardMessageCommand,
  SendReactionCommand,
  PrepareMediaCommand,
  SendMediaCommand,
} from './dtos/commands.js';
export { MAX_SEARCH_FANOUT_CALLS } from './dtos/commands.js';

export { SessionGate } from './services/session-gate.js';
export { PolicyApplicationService } from './services/policy-application.js';

export type { UseCase } from './use-cases/use-case.js';
export type { EndpointExecutionContext } from './use-cases/context.js';
export type {
  ReadUseCaseDeps,
  WriteUseCaseDeps,
} from './use-cases/use-case-engine.js';
export {
  makeReadUseCase,
  makeWriteUseCase,
} from './use-cases/use-case-engine.js';
export { READ_SPECS } from './use-cases/read-use-case-impls.js';
export {
  WRITE_SPECS,
  createPrepareMediaUseCase,
} from './use-cases/write-use-case-impls.js';
