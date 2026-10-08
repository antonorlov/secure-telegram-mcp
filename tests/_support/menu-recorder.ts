/**
 * A recording `SetupUi`: every menu the flow opens is captured verbatim and answered from a
 * script of option values, so a suite can assert which rows the operator is offered in a given
 * state — and, the point of the matrix, which rows they are NOT.
 */
import { expect } from 'vitest';
import type {
  AccessPickerRequest,
  AccessPickerResult,
  ConfirmPromptRequest,
  MenuRequest,
  MenuResult,
  NoticeRequest,
  PasswordPromptRequest,
  PromptResult,
  SetupUi,
  TextPromptRequest,
} from '../../src/presentation/cli/ink/setup-ui-port.js';

export interface RecordedMenu {
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly labels: readonly string[];
  readonly values: readonly string[];
  readonly hints: readonly string[];
}

// The scripted answer for an Esc/q on a menu, as opposed to landing Enter on a row.
export const CANCEL = '__cancel__';

/**
 * Drives a flow through menus only. A prompt, picker or QR screen throws: a matrix suite
 * navigates, it does not fill anything in, and an unexpected prompt means the flow took a
 * branch the script did not intend.
 */
export class MenuRecorder {
  public readonly menus: RecordedMenu[] = [];
  // Everything the operator is told outside a menu, in order.
  public readonly notices: string[] = [];
  // `runSetup` swallows a thrown error and exits, so the reason is kept here for the suite
  // to re-raise — otherwise a mis-scripted flow reads as a bare exit.
  public failure: Error | undefined;
  private cursor = 0;

  public constructor(private readonly script: readonly string[]) {}

  public readonly ui: SetupUi = {
    menu: <T,>(request: MenuRequest<T>): Promise<MenuResult<T>> =>
      Promise.resolve(this.answer(request)),
    text: (request: TextPromptRequest): Promise<PromptResult<string>> =>
      this.unscripted('text prompt', request.title),
    password: (request: PasswordPromptRequest): Promise<PromptResult<string>> =>
      this.unscripted('password prompt', request.title),
    confirm: (request: ConfirmPromptRequest): Promise<PromptResult<boolean>> =>
      this.unscripted('confirm prompt', request.title),
    pickAccess: (_request: AccessPickerRequest): Promise<AccessPickerResult> =>
      this.unscripted('access picker', 'access'),
    notify: (line: string): void => {
      this.notices.push(line);
    },
    notice: (request: NoticeRequest): Promise<void> => {
      this.notices.push([request.title, ...request.body].join('\n'));
      return Promise.resolve();
    },
    showQr: (): void => undefined,
    status: <T,>(_label: string, task: () => Promise<T>): Promise<T> => task(),
  };

  // The menu at `index` in open order, or `undefined` past the end.
  public at(index: number): RecordedMenu | undefined {
    return this.menus[index];
  }

  public titles(): readonly string[] {
    return this.menus.map((menu) => menu.title);
  }

  private answer<T>(request: MenuRequest<T>): MenuResult<T> {
    const recorded: RecordedMenu = {
      title: request.title,
      subtitle: request.subtitle,
      labels: request.options.map((option) => option.label),
      values: request.options.map((option) => String(option.value)),
      hints: request.options.map((option) => option.hint ?? ''),
    };
    this.menus.push(recorded);
    const choice = this.script[this.cursor];
    this.cursor += 1;
    if (choice === undefined) {
      this.fail(
        `menu "${request.title}" (#${String(this.cursor)}) was not scripted; it offers ${recorded.values.join(', ')}`,
      );
    }
    if (choice === CANCEL) {
      return { kind: 'cancelled' };
    }
    // A script may only land on a row the menu actually shows, so navigation itself
    // proves the row exists in that state.
    if (!recorded.values.includes(choice)) {
      this.fail(
        `menu "${request.title}" does not offer "${choice}"; it offers ${recorded.values.join(', ')}`,
      );
    }
    return { kind: 'selected', value: choice as T };
  }

  private unscripted(kind: string, title: string): never {
    return this.fail(
      `the flow opened a ${kind} ("${title}"); this recorder scripts menus only`,
    );
  }

  private fail(message: string): never {
    this.failure ??= new Error(message);
    throw this.failure;
  }
}

export interface MenuGolden {
  // A string is exact; a RegExp matches — for a subtitle carrying a live account label.
  readonly title?: string | RegExp;
  readonly subtitle?: string | RegExp;
  // The full row list, in order. The first row is what Enter lands on.
  readonly rows?: readonly string[];
  // Substrings that must appear nowhere on the screen: title, subtitle, labels or hints.
  readonly mustNotContain?: readonly string[];
}

const expectText = (actual: string, expected: string | RegExp, what: string): void => {
  if (typeof expected === 'string') {
    expect(actual, what).toBe(expected);
  } else {
    expect(actual, what).toMatch(expected);
  }
};

export const expectMenu = (menu: RecordedMenu | undefined, golden: MenuGolden): void => {
  expect(menu, 'no menu was opened at this position in the flow').toBeDefined();
  if (menu === undefined) return;
  if (golden.title !== undefined) {
    expectText(menu.title, golden.title, 'menu title');
  }
  if (golden.subtitle !== undefined) {
    expectText(menu.subtitle ?? '', golden.subtitle, `subtitle of "${menu.title}"`);
  }
  if (golden.rows !== undefined) {
    expect(menu.labels, `rows of "${menu.title}"`).toEqual(golden.rows);
  }
  const surface = [menu.title, menu.subtitle ?? '', ...menu.labels, ...menu.hints].join('\n');
  for (const needle of golden.mustNotContain ?? []) {
    expect(surface, `"${needle}" must not appear on "${menu.title}"`).not.toContain(needle);
  }
};
