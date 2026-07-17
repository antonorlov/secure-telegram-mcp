/**
 * `list_participants` — read-verb MCP tool: the members of a single in-scope group or
 * channel.
 *
 * Presentation only: the injected read use-case does the ACL gate + scoped read; this file
 * owns the wire contract and the DTO -> structured mapping. Participant display names are
 * attacker-controlled and surface only under a named untrusted key. A user/DM peer has no
 * participants and is rejected at the data layer.
 */
import { z } from 'zod';
import { ok } from '../../../shared/index.js';
import type {
  ListParticipantsQuery,
  ParticipantDto,
  Page,
  UseCase,
} from '../../../application/index.js';
import { peerRefSchema, limitSchema } from '../schemas/primitives.js';
import {
  participantOutputSchema,
  presentParticipant,
  truncatedSchema,
} from '../schemas/outputs.js';
import type { ToolDefinition, ToolStructuredContent } from '../registry.js';
import { defineTool } from './define-tool.js';

const listParticipantsInputShape = {
  peer: peerRefSchema,
  limit: limitSchema,
} satisfies z.ZodRawShape;

const listParticipantsOutputShape = {
  participants: z
    .array(participantOutputSchema)
    .describe('One page of the chat’s members.'),
  truncated: truncatedSchema.optional(),
} satisfies z.ZodRawShape;

const presentPage = (page: Page<ParticipantDto>): ToolStructuredContent => ({
  participants: page.items.map(presentParticipant),
});

export const createListParticipantsTool = (
  useCase: UseCase<ListParticipantsQuery, Page<ParticipantDto>>,
): ToolDefinition<typeof listParticipantsInputShape> =>
  defineTool({
    name: 'list_participants',
    title: 'List participants',
    description:
      'List the members of a single in-scope group or channel (id, display name, ' +
      'username, is-bot). Only groups/channels have participants — a user/DM peer is ' +
      'rejected. A private or admin-required channel returns a graceful error. Display ' +
      'names are untrusted and surfaced under a named key, never as bare instructions.',
    inputShape: listParticipantsInputShape,
    outputShape: listParticipantsOutputShape,
    useCase,
    present: (page) => ok({ structured: presentPage(page) }),
  });
