import { describe, expect, it } from 'vitest';

import { shouldSubmitComposerKey } from './composer-keyboard';

const enter = {
  key: 'Enter',
  shiftKey: false,
  repeat: false,
  nativeIsComposing: false,
  nativeKeyCode: 13,
};

describe('shouldSubmitComposerKey', () => {
  it('submits a plain Enter', () => {
    expect(shouldSubmitComposerKey(enter, false)).toBe(true);
  });

  it('does not submit while the local composition guard is active', () => {
    expect(shouldSubmitComposerKey(enter, true)).toBe(false);
  });

  it('does not submit when the browser reports an active composition', () => {
    expect(
      shouldSubmitComposerKey({ ...enter, nativeIsComposing: true }, false),
    ).toBe(false);
  });

  it('does not submit the legacy IME keyCode 229 event', () => {
    expect(
      shouldSubmitComposerKey({ ...enter, nativeKeyCode: 229 }, false),
    ).toBe(false);
  });

  it('keeps Shift+Enter for a newline and ignores key repeat', () => {
    expect(shouldSubmitComposerKey({ ...enter, shiftKey: true }, false)).toBe(
      false,
    );
    expect(shouldSubmitComposerKey({ ...enter, repeat: true }, false)).toBe(
      false,
    );
  });
});
