/**
 * LinePrompt — the thin wrapper over `@inkjs/ui`'s single-line inputs for one field.
 * It is controlled at the SEAM: the operator types into the `@inkjs/ui` field (which
 * owns the raw-mode input for the mounted duration), and on Enter we `transform` +
 * `validate`; a failed validation is RECOVERABLE (the error shows, the field stays
 * open). Esc raises a cancel.
 *
 * `masked` selects the secret variant (2FA password, PIN/passphrase, api_hash): every
 * character is masked by `PasswordInput`, the value is raised ONLY through `onDone` and
 * is never written to the transcript/log, and no default is ever pre-filled — the
 * `PasswordPromptRequest` port type has no `defaultValue`, and the spread below is
 * additionally gated off for the masked variant.
 *
 * There is NO second stdin owner here: this mounts inside the ONE persistent Ink
 * app, so it composes with the router rather than calling its own `render()`.
 */
import { useState, type FC } from 'react';
import { useInput } from 'ink';
import { PasswordInput, TextInput } from '@inkjs/ui';

import type {
  PasswordPromptRequest,
  PromptResult,
  TextPromptRequest,
} from '../setup-ui-port.js';
import { PromptFrame } from './PromptFrame.js';

export interface LinePromptProps {
  /** `PasswordPromptRequest` is a structural subset (no `defaultValue`), so both fit. */
  readonly request: TextPromptRequest | PasswordPromptRequest;
  /** Mask every typed character and never pre-fill (the secret variant). */
  readonly masked: boolean;
  readonly onDone: (result: PromptResult<string>) => void;
}

export const LinePrompt: FC<LinePromptProps> = ({ request, masked, onDone }) => {
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = (raw: string): void => {
    const value = request.transform !== undefined ? request.transform(raw) : raw;
    const validationError = request.validate?.(value);
    if (validationError !== undefined) {
      setError(validationError);
      return;
    }
    onDone({ kind: 'submitted', value });
  };

  // Esc cancels. `@inkjs/ui`'s inputs ignore Escape, so this sibling handler is the
  // only thing that reacts to it (both `useInput`s may coexist in Ink).
  useInput(
    (_input, key) => {
      if (key.escape) {
        onDone({ kind: 'cancelled' });
      }
    },
    { isActive: true },
  );

  const defaultValue =
    !masked && 'defaultValue' in request ? request.defaultValue : undefined;
  const inputProps = {
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    onSubmit: handleSubmit,
  };

  const submitHint = 'enter submit · esc cancel';
  return (
    <PromptFrame
      title={request.title}
      {...(request.subtitle !== undefined ? { subtitle: request.subtitle } : {})}
      {...(request.help !== undefined ? { help: request.help } : {})}
      {...(error !== undefined ? { error } : {})}
      hint={masked ? `input hidden · ${submitHint}` : submitHint}
    >
      {masked ? <PasswordInput {...inputProps} /> : <TextInput {...inputProps} />}
    </PromptFrame>
  );
};
