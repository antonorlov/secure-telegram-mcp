/**
 * Tool catalogue — the single place that assembles the full v1 set of MCP tool definitions.
 * This barrel exposes `buildToolDefinitions(deps)`, which builds each tool's use-case from
 * the application spec tables (`READ_SPECS` / `WRITE_SPECS` + the shared engines) and
 * returns the heterogeneous `readonly AnyToolDefinition[]` the composition root hands to
 * the `ToolRegistry`. Per-tool dep policy lives in the application layer: `search` draws
 * read-side quota from the limiter via its spec's gate, and `prepare_media` skips
 * HITL/quota by construction (its bespoke factory takes only the read deps).
 *
 * Presentation-only: no GramJS type is referenced here. It builds the full catalogue
 * unconditionally, and the `ToolRegistry` registers all of it for every endpoint: the menu
 * is static (discovery). A read-only endpoint therefore lists the write tools too — they
 * deny at execution, where the per-chat verb+scope+kill check (the sole ACL) runs.
 * Forbidden bypass names are still never wired.
 *
 * A new tool slots in by adding a factory module, its spec to READ_SPECS/WRITE_SPECS, and
 * one line here.
 */
import type { AnyToolDefinition } from '../registry.js';
import {
  makeReadUseCase,
  makeWriteUseCase,
  createPrepareMediaUseCase,
  READ_SPECS,
  WRITE_SPECS,
  type WriteUseCaseDeps,
} from '../../../application/index.js';

import { createGetMessagesTool } from './getMessages.js';
import { createSearchMessagesTool } from './searchMessages.js';
import { createListDialogsTool } from './listDialogs.js';
import { createListTopicsTool } from './listTopics.js';
import { createGetChatInfoTool } from './getChatInfo.js';
import { createGetMediaInfoTool } from './getMediaInfo.js';
import { createDownloadMediaTool } from './downloadMedia.js';
import { createGetPinnedMessagesTool } from './getPinnedMessages.js';
import { createListParticipantsTool } from './listParticipants.js';
import { createSendMessageTool } from './sendMessage.js';
import { createEditMessageTool } from './editMessage.js';
import { createDeleteMessageTool } from './deleteMessage.js';
import { createSaveDraftTool } from './saveDraft.js';
import { createMarkReadTool } from './markRead.js';
import { createForwardMessageTool } from './forwardMessage.js';
import { createSendReactionTool } from './sendReaction.js';
import { createPrepareMediaTool, createSendMediaTool } from './sendMedia.js';

/**
 * Assemble the complete v1 tool catalogue as an immutable array, wiring each tool factory
 * to its use-case built from the spec tables over the one engine deps bundle (a superset
 * of what each engine needs; reads simply ignore the limiter/confirmer). Read tools first,
 * then the per-verb write tools, then the two-phase media pair — a stable, legible order;
 * the `ToolRegistry` lists them all for every endpoint, so ordering carries no security
 * meaning. Each precise `ToolDefinition<Shape>` widens to `AnyToolDefinition` with no cast
 * (the registry's method-syntax handler makes the parameter comparison bivariant), and
 * args are re-validated against `inputSchema` before any handler runs.
 */
export const buildToolDefinitions = (
  deps: WriteUseCaseDeps,
): readonly AnyToolDefinition[] => {
  const definitions: readonly AnyToolDefinition[] = [
    // READ tier (verb = read).
    createGetMessagesTool(makeReadUseCase(deps, READ_SPECS.getMessages)),
    // Search draws read-side quota (the un-peered fan-out costs scope-size units).
    createSearchMessagesTool(makeReadUseCase(deps, READ_SPECS.searchMessages)),
    createListDialogsTool(makeReadUseCase(deps, READ_SPECS.listDialogs)),
    createListTopicsTool(makeReadUseCase(deps, READ_SPECS.listTopics)),
    createGetChatInfoTool(makeReadUseCase(deps, READ_SPECS.getChatInfo)),
    createGetMediaInfoTool(makeReadUseCase(deps, READ_SPECS.getMediaInfo)),
    createGetPinnedMessagesTool(
      makeReadUseCase(deps, READ_SPECS.getPinnedMessages),
    ),
    createListParticipantsTool(
      makeReadUseCase(deps, READ_SPECS.listParticipants),
    ),
    // Media EGRESS (its own read_media verb; submits an audit record on success).
    createDownloadMediaTool(makeReadUseCase(deps, READ_SPECS.downloadMedia)),
    // WRITE tier (each its own least-privilege verb).
    createSendMessageTool(makeWriteUseCase(deps, WRITE_SPECS.sendMessage)),
    createEditMessageTool(makeWriteUseCase(deps, WRITE_SPECS.editMessage)),
    createDeleteMessageTool(makeWriteUseCase(deps, WRITE_SPECS.deleteMessage)),
    createSaveDraftTool(makeWriteUseCase(deps, WRITE_SPECS.saveDraft)),
    createMarkReadTool(makeWriteUseCase(deps, WRITE_SPECS.markRead)),
    createForwardMessageTool(
      makeWriteUseCase(deps, WRITE_SPECS.forwardMessage),
    ),
    createSendReactionTool(makeWriteUseCase(deps, WRITE_SPECS.sendReaction)),
    // Two-phase media (both verb = send). prepare_media skips HITL/quota (local,
    // no Telegram side effect) but submits an audit record like every other
    // write-tier op.
    createPrepareMediaTool(createPrepareMediaUseCase(deps)),
    createSendMediaTool(makeWriteUseCase(deps, WRITE_SPECS.sendMedia)),
  ];
  return Object.freeze(definitions);
};
