/**
 * ConfirmPrompt — the thin wrapper over `@inkjs/ui`'s `ConfirmInput` for a yes/no decision
 * (write-confirm, "Set a PIN?", "Keep this login?", …). `onConfirm`/`onCancel` are the field's
 * yes/no; those resolve a `submitted` boolean. Esc is distinct from a "no" answer — it resolves
 * a `cancelled` outcome so a caller can tell "answered no" from "backed out".
 */
import type { FC } from 'react';
import { useInput } from 'ink';
import { ConfirmInput } from '@inkjs/ui';

import type { ConfirmPromptRequest, PromptResult } from '../setup-ui-port.js';
import { PromptFrame } from './PromptFrame.js';

export interface ConfirmPromptProps {
  readonly request: ConfirmPromptRequest;
  readonly onDone: (result: PromptResult<boolean>) => void;
}

export const ConfirmPrompt: FC<ConfirmPromptProps> = ({ request, onDone }) => {

  useInput(
    (_input, key) => {
      if (key.escape) {
        onDone({ kind: 'cancelled' });
      }
    },
    { isActive: true },
  );

  return (
    <PromptFrame
      title={request.title}
      {...(request.subtitle !== undefined ? { subtitle: request.subtitle } : {})}
      {...(request.help !== undefined ? { help: request.help } : {})}
      hint={
        request.defaultValue
          ? 'Y/n · enter accepts default (yes) · esc cancel'
          : 'y/N · enter accepts default (no) · esc cancel'
      }
    >
      <ConfirmInput
        defaultChoice={request.defaultValue ? 'confirm' : 'cancel'}
        onConfirm={(): void => {
          onDone({ kind: 'submitted', value: true });
        }}
        onCancel={(): void => {
          onDone({ kind: 'submitted', value: false });
        }}
      />
    </PromptFrame>
  );
};
