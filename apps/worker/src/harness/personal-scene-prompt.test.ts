import { expect, it } from 'vitest';
import { personalScenePromptParts } from './personal-scene-prompt.js';

it('separates verified original text without interpreting slash/quoted intent or losing bytes', () => {
  const human = '请用 /weekly；引用「/other」也保持原生语法。';
  const tail = 'Current attachments: /attachment\nCompany template: /template';
  const input = `${human}\n\n${tail}`;
  const context = 'Bridge /bridge\nConversation /history\nMemory /memory';
  const parts = personalScenePromptParts(context, input, {
    humanText: human,
    kernelUserRequest: input,
  });
  expect(parts).toEqual([
    { kind: 'allrice-context', text: context },
    { kind: 'user', text: human },
    { kind: 'allrice-context', text: tail },
  ]);
  expect(parts.map((p) => p.text).join('\n\n')).toBe(`${context}\n\n${input}`);
});

it('internal producers and synthetic copied-kernel prompts never claim a human source', () => {
  expect(personalScenePromptParts('', '/weekly', undefined)).toEqual([
    { kind: 'allrice-context', text: '/weekly' },
  ]);
  expect(
    personalScenePromptParts('', '/repair', {
      kernelUserRequest: '/weekly',
      humanText: '/weekly',
    }),
  ).toEqual([{ kind: 'allrice-context', text: '/repair' }]);
  expect(
    personalScenePromptParts('', '/weekly', { kernelUserRequest: '/weekly' }),
  ).toEqual([{ kind: 'allrice-context', text: '/weekly' }]);
});

it('refuses a mismatched persisted source instead of searching for human text inside context', () => {
  expect(() =>
    personalScenePromptParts('', 'Prefix\n/weekly', {
      kernelUserRequest: 'Prefix\n/weekly',
      humanText: '/weekly',
    }),
  ).toThrow('employee_scene_human_source_mismatch');
});
