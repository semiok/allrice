export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  nativeIsComposing: boolean;
  nativeKeyCode: number;
}

/**
 * Mirrors the DSH WebUI composer guard. Browser IMEs do not report composition
 * consistently, so all three signals are required before Enter may submit.
 */
export function shouldSubmitComposerKey(
  input: ComposerKeyInput,
  compositionActive: boolean,
) {
  return (
    input.key === 'Enter' &&
    !input.shiftKey &&
    !input.repeat &&
    !compositionActive &&
    !input.nativeIsComposing &&
    input.nativeKeyCode !== 229
  );
}
