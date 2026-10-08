/**
 * ElicitationConfirmer — the human-in-the-loop `Confirmer` for the stdio MCP surface. When a
 * write use-case requires confirmation (the endpoint's `confirmWrites` is on and the verb is a
 * write), it asks the connected MCP client to confirm via MCP elicitation
 * (`elicitation/create`, form mode).
 *
 * Fail-closed by construction:
 *  - Only `action === 'accept'` and the boolean form field set to `true` is treated as
 *    approval; decline / cancel / a falsy field all mean deny.
 *  - A client that never declared elicitation gets `CONFIRMATION_REQUIRED` without being asked.
 *    An unattached server or a request that errors returns `Err` as well — the use-case then
 *    refuses the write (default-deny). The model can never self-approve.
 *
 * The prompt is built only from the structured `ConfirmationRequest` (operator-facing
 * verb/target/description) — never from untrusted Telegram prose — so an injected message
 * cannot hijack the confirmation.
 *
 * Late binding: the use-cases (and thus this confirmer) are constructed before the `McpServer`
 * exists. The composition root calls {@link attach} once the server is built; until then every
 * request fails closed.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AppErrorCode, appError } from '../../application/index.js';
import type {
  AppError,
  ConfirmationRequest,
  Confirmer,
} from '../../application/index.js';
import { type Result, ok, err } from '../../shared/index.js';

const APPROVE_FIELD = 'approve';

export class ElicitationConfirmer implements Confirmer {
  private server: McpServer | undefined;

  // Bind the live MCP server once it has been built (composition root).
  public attach(server: McpServer): void {
    this.server = server;
  }

  public async requestConfirmation(
    request: ConfirmationRequest,
  ): Promise<Result<boolean, AppError>> {
    const server = this.server;
    if (server === undefined) {
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          'confirmation channel not ready',
        ),
      );
    }

    // A client that never declared elicitation cannot show the prompt at all. That is a write
    // which needs a confirmation it cannot get — not an outage — so it is refused as such,
    // without asking.
    if (server.server.getClientCapabilities()?.elicitation === undefined) {
      return err(
        appError(
          AppErrorCode.ConfirmationRequired,
          'this MCP client cannot show confirmation prompts, and writes on this endpoint require one',
        ),
      );
    }

    const targetSuffix =
      request.targetChatId !== undefined ? ` (chat ${request.targetChatId})` : '';
    const message =
      `Approve '${request.verb}' on endpoint '${request.endpointName}'` +
      `${targetSuffix}? ${request.description}`;

    try {
      const result = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            [APPROVE_FIELD]: {
              type: 'boolean',
              title: 'Approve this write',
              description: 'Set true to allow this action to proceed.',
            },
          },
          required: [APPROVE_FIELD],
        },
      });
      if (result.action !== 'accept') {
        return ok(false);
      }
      return ok(result.content?.[APPROVE_FIELD] === true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      return err(
        appError(
          AppErrorCode.GatewayUnavailable,
          `confirmation could not be requested: ${detail}`,
        ),
      );
    }
  }
}
