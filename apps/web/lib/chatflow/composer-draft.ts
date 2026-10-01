import type { TaskSuggestionDisplay } from '@allrice/contracts';

export interface PreparedComposerDraft {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Only named slots in the selected template are rendered; user drafts are opaque. */
export function renderTaskSuggestion(
  suggestion: TaskSuggestionDisplay,
  values: Record<string, string> = {},
): PreparedComposerDraft {
  const slots = new Map(
    (suggestion.slots ?? []).map((slot) => [slot.name, slot]),
  );
  let first: { start: number; end: number } | undefined;
  let consumed = 0;
  const text = suggestion.template.replace(
    /\{\{([^{}]+)\}\}/gu,
    (match: string, name: string, offset: number) => {
      const slot = slots.get(name);
      if (!slot) throw new Error(`未配置参数：${name}`);
      const value =
        values[name] ??
        slot.defaultValue ??
        (slot.required ? '' : (slot.options?.[0] ?? slot.label));
      if (slot.required && !value.trim())
        throw new Error(`请填写${slot.label}`);
      if (slot.options && !slot.options.includes(value))
        throw new Error(`请选择${slot.label}`);
      if (!first)
        first = {
          start: offset + consumed,
          end: offset + consumed + value.length,
        };
      consumed += value.length - match.length;
      return value;
    },
  );
  if (text.length > 40_000)
    throw new Error('参数展开后的草稿过长，请缩短参数内容。');
  return {
    text,
    selectionStart: first?.start ?? text.length,
    selectionEnd: first?.end ?? text.length,
  };
}

/** Preserve every original draft character, attachment and reference; append text only. */
export function appendComposerDraft(
  current: string,
  prepared: PreparedComposerDraft,
): PreparedComposerDraft {
  const prefix = current.length ? `${current}\n\n` : '';
  return {
    text: prefix + prepared.text,
    selectionStart: prefix.length + prepared.selectionStart,
    selectionEnd: prefix.length + prepared.selectionEnd,
  };
}

export function prepareComposerText(text: string): PreparedComposerDraft {
  return { text, selectionStart: text.length, selectionEnd: text.length };
}
