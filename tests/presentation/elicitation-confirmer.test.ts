/**
 * ElicitationConfirmer — the human-in-the-loop chokepoint's FAIL-CLOSED parsing.
 * Only an explicit `action: 'accept'` + boolean-true `approve` approves a write;
 * every other shape (decline, cancel, truthy-but-not-true, missing content,
 * unattached server, thrown transport) must NOT approve.
 */
import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ElicitationConfirmer } from '../../src/presentation/mcp/elicitation-confirmer.js';
import { AppErrorCode } from '../../src/application/errors.js';
import { unwrap } from '../../src/shared/result.js';
import { EndpointName, PermissionVerb } from '../../src/domain/index.js';

const REQUEST = {
  endpointName: unwrap(EndpointName.create('reader')),
  verb: PermissionVerb.Send,
  targetChatId: '100',
  description: 'send one message',
};

/** A fake McpServer exposing only the elicitInput seam the confirmer uses. */
const serverAnswering = (
  answer: unknown,
): McpServer =>
  ({
    server: {
      elicitInput: (): Promise<unknown> => Promise.resolve(answer),
    },
  }) as unknown as McpServer;

const confirmerWith = (server: McpServer): ElicitationConfirmer => {
  const confirmer = new ElicitationConfirmer();
  confirmer.attach(server);
  return confirmer;
};

describe('ElicitationConfirmer — fail-closed decision parsing', () => {
  it('UNATTACHED (no live server): Err, never an implicit approve', async () => {
    const result = await new ElicitationConfirmer().requestConfirmation(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.GatewayUnavailable);
    }
  });

  it('approves ONLY on accept + approve === true', async () => {
    const result = await confirmerWith(
      serverAnswering({ action: 'accept', content: { approve: true } }),
    ).requestConfirmation(REQUEST);
    expect(result).toEqual({ ok: true, value: true });
  });

  it('accept with approve false / truthy-non-boolean / missing content -> NOT approved', async () => {
    for (const answer of [
      { action: 'accept', content: { approve: false } },
      { action: 'accept', content: { approve: 'yes' } }, // truthy but not `true`
      { action: 'accept', content: { approve: 1 } },
      { action: 'accept', content: {} },
      { action: 'accept' }, // no content at all
    ]) {
      const result = await confirmerWith(serverAnswering(answer)).requestConfirmation(
        REQUEST,
      );
      expect(result).toEqual({ ok: true, value: false });
    }
  });

  it('decline and cancel actions -> NOT approved (regardless of content)', async () => {
    for (const answer of [
      { action: 'decline', content: { approve: true } },
      { action: 'cancel' },
    ]) {
      const result = await confirmerWith(serverAnswering(answer)).requestConfirmation(
        REQUEST,
      );
      expect(result).toEqual({ ok: true, value: false });
    }
  });

  it('a thrown elicitation (client cannot show the prompt) -> Err, write stays blocked', async () => {
    const throwing = {
      server: {
        elicitInput: (): Promise<never> =>
          Promise.reject(new Error('client does not support elicitation')),
      },
    } as unknown as McpServer;
    const result = await confirmerWith(throwing).requestConfirmation(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(AppErrorCode.GatewayUnavailable);
    }
  });
});
