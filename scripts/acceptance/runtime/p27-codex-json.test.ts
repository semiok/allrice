import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';
import {
  codexJsonDiagnostics,
  parseP27CodexJson,
  P27CodexJsonError,
  type P27CodexJsonStage,
} from './p27-codex-json.ts';

describe('bounded acceptance JSON frames, no model or credentials', () => {
  it.each(['child_report', 'parent_answer', 'ordinary_answer'] as const)(
    'accepts exact plain JSON and one complete JSON fence at %s',
    (stage) => {
      for (const source of [
        ' {"sum":579}\n',
        '```json\n{"sum":579}\n```',
        '```JSON\r\n{"sum":579}\r\n```',
        '```\n{"sum":579}\n```',
        '~~~json\n{"sum":579}\n~~~',
      ]) {
        const parsed = parseP27CodexJson(source, stage);
        expect(parsed.value).toEqual({ sum: 579 });
        expect(parsed.observation).toMatchObject({
          stage,
          isJson: true,
          isObject: true,
          accepted: true,
          failure: null,
        });
        expect(parsed.observation.digest).toBe(
          `sha256:${createHash('sha256').update(source).digest('hex')}`,
        );
      }
    },
  );
  it('keeps the production artifact envelope plain JSON', () => {
    expect(
      parseP27CodexJson('{"content":"{}"}', 'artifact_envelope').value,
    ).toEqual({ content: '{}' });
    expect(() =>
      parseP27CodexJson('```json\n{"content":"{}"}\n```', 'artifact_envelope'),
    ).toThrow('P27_CODEX_JSON_ARTIFACT_ENVELOPE_INVALID');
  });
  it.each([
    undefined,
    null,
    {},
    '',
    ' ',
    '{"sum":579}{"sum":579}',
    'Here is the answer: {"sum":579}',
    '{"sum":579}\nDone.',
    'text\n```json\n{"sum":579}\n```',
    '```json\n{"sum":579}\n```\ntext',
    '```json\n{"sum":579}\n```\n```json\n{"sum":579}\n```',
    '```json\n{"sum":579}',
    '```js\n{"sum":579}\n```',
    '```json\n{"sum":579}\n~~~',
    '"{\\"sum\\":579}"',
    'null',
    '[]',
    '{"sum":0,"sum":579}',
    '{"sum":0,"s\\u0075m":579}',
    '{"nested":{"x":0,"x":1}}',
    '{"sum":579,}',
  ])(
    'refuses missing, double, prose, ambiguous or non-object input %#',
    (source) => {
      expect(() => parseP27CodexJson(source, 'parent_answer')).toThrow(
        'P27_CODEX_JSON_PARENT_ANSWER_INVALID',
      );
    },
  );
  it('keeps stage and safe framing flags, never raw model text or SyntaxError', () => {
    const secret = 'private-model-thought-SHOULD-NOT-LEAK';
    for (const stage of [
      'artifact_envelope',
      'child_report',
      'parent_answer',
      'ordinary_answer',
    ] as P27CodexJsonStage[]) {
      const observations: unknown[] = [];
      try {
        parseP27CodexJson(`not json ${secret}`, stage, (value) =>
          observations.push(value),
        );
        expect.fail('invalid source must fail');
      } catch (error) {
        expect(error).toBeInstanceOf(P27CodexJsonError);
        expect(codexJsonDiagnostics(error)).toMatchObject({
          stage,
          hasFence: false,
          isFence: false,
          isJson: false,
          accepted: false,
          failure: 'invalid_json',
        });
        const safe = JSON.stringify({
          diagnostics: p27ErrorDiagnostics(error),
          parsing: codexJsonDiagnostics(error),
          observations,
        });
        expect(safe).not.toContain(secret);
        expect(safe).not.toContain('not json');
        expect(safe).toContain(`P27_CODEX_JSON_${stage.toUpperCase()}_INVALID`);
      }
    }
    expect(codexJsonDiagnostics(new SyntaxError(secret))).toBeNull();
    const forged = Object.create(P27CodexJsonError.prototype);
    Object.defineProperty(forged, 'observation', {
      get: () => {
        throw new Error(secret);
      },
    });
    expect(codexJsonDiagnostics(forged)).toBeNull();
  });
  it('bounds text and handles duplicate keys without confusing strings or nested arrays', () => {
    expect(() =>
      parseP27CodexJson('x'.repeat(140001), 'child_report'),
    ).toThrow();
    expect(
      parseP27CodexJson(
        '{"rows":[{"key":1},{"key":2}],"text":"{},[x]:\\"quoted\\""}',
        'child_report',
      ).value.rows,
    ).toEqual([{ key: 1 }, { key: 2 }]);
  });
});
