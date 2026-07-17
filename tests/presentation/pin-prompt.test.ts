/**
 * promptPin — the masked TTY secret reader for the daemon unlock path.
 *
 * Regression: the wrong-PIN retry loop calls promptPin AGAIN on the same stdin.
 * The first prompt's cleanup explicitly pauses the stream, and Node does not
 * auto-resume an explicitly-paused stream when a 'data' listener attaches — so
 * without an explicit resume() the second prompt never received input and the
 * process exited silently with a dangling "PIN: " (observed live).
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';

import { promptPin } from '../../src/presentation/cli/pin-prompt.js';

const makeStreams = (): { input: PassThrough; output: PassThrough } => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // drain the echo so writes never block
  return { input, output };
};

describe('promptPin', () => {
  it('reads one masked line', async () => {
    const { input, output } = makeStreams();
    const read = promptPin('PIN: ', { input, output });
    input.write('secret-1\n');
    expect(await read).toBe('secret-1');
  });

  it('re-prompts on the SAME stream after a completed read (wrong-PIN retry)', async () => {
    const { input, output } = makeStreams();

    const first = promptPin('PIN: ', { input, output });
    input.write('wrong-pin\n');
    expect(await first).toBe('wrong-pin');

    // The first cleanup paused the stream; the retry prompt must still read.
    const second = promptPin('PIN: ', { input, output });
    input.write('right-pin\n');
    expect(await second).toBe('right-pin');
  });

  it('resolves undefined on Ctrl-C', async () => {
    const { input, output } = makeStreams();
    const read = promptPin('PIN: ', { input, output });
    input.write('');
    expect(await read).toBeUndefined();
  });
});
