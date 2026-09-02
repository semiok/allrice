import { HandlerError } from '../errors.js';
import type {
  ManagedBrowserAction,
  ManagedBrowserStep,
} from '../managed-browser.js';
import { limitValue, objectValue, stringValue } from './input-values.js';

/**
 * Keep attacker-controlled browser output inside one explicit data boundary.
 * Escaping angle brackets prevents a page from closing the wrapper and
 * injecting a fake system/tool block into the model transcript.
 */
export function managedBrowserUntrustedContent(input: {
  url: string;
  title: string;
  text: string;
  actions: ManagedBrowserAction[];
}) {
  const payload = JSON.stringify(input)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return [
    '<external-content source="browser.run" trust="untrusted">',
    payload,
    '</external-content>',
  ].join('\n');
}

export function managedBrowserStepValues(value: unknown) {
  if (value === undefined) {
    return {
      runtime: [] as ManagedBrowserStep[],
      stored: [] as Array<
        | { type: 'wait_for'; selector: string; timeoutMs: number }
        | { type: 'follow_link'; selector: string }
        | { type: 'scroll'; direction: 'up' | 'down'; distancePx: number }
      >,
    };
  }
  if (!Array.isArray(value) || value.length > 12) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'steps 必须是不超过 12 项的只读浏览器步骤',
      false,
    );
  }
  const runtime: ManagedBrowserStep[] = [];
  const stored: Array<
    | { type: 'wait_for'; selector: string; timeoutMs: number }
    | { type: 'follow_link'; selector: string }
    | { type: 'scroll'; direction: 'up' | 'down'; distancePx: number }
  > = [];
  for (const raw of value) {
    const step = objectValue(raw);
    if (step.type === 'waitFor') {
      const selector = stringValue(step.selector, 'selector');
      const timeoutMs = limitValue(step.timeoutMs, 10_000, 30_000);
      runtime.push({ type: 'waitFor', selector, timeoutMs });
      stored.push({ type: 'wait_for', selector, timeoutMs });
      continue;
    }
    if (step.type === 'followLink') {
      const selector = stringValue(step.selector, 'selector');
      runtime.push({ type: 'followLink', selector });
      stored.push({ type: 'follow_link', selector });
      continue;
    }
    if (step.type === 'scroll') {
      const direction = step.direction === 'up' ? 'up' : 'down';
      const pixels = limitValue(step.pixels, 800, 5_000);
      runtime.push({ type: 'scroll', direction, pixels });
      stored.push({ type: 'scroll', direction, distancePx: pixels });
      continue;
    }
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '浏览器只支持 waitFor、followLink 和 scroll 步骤',
      false,
    );
  }
  return { runtime, stored };
}
