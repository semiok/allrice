import { describe, expect, it } from 'vitest';
import type { TaskSuggestionDisplay } from '@allrice/contracts';
import { taskSuggestionPreparations } from './task-preparation';

const task: TaskSuggestionDisplay = {
  id: 'read-local-browser',
  title: '读取本地浏览器',
  template: '只读查看本地浏览器中的页面。',
  readiness: ['local_browser'],
  preparation: ['bridge'],
};

describe('task-specific preparation guidance', () => {
  it('keeps computer preparation when the browser is missing but files are ready', () => {
    expect(
      taskSuggestionPreparations([task], {
        capabilities: [
          { id: 'local_files', state: 'ready' },
          { id: 'local_browser', state: 'needs_configuration' },
        ],
      }),
    ).toEqual(['bridge']);
  });

  it('does not require a folder for a ready browser-only task', () => {
    expect(
      taskSuggestionPreparations([task], {
        capabilities: [
          { id: 'local_files', state: 'needs_configuration' },
          { id: 'local_browser', state: 'ready' },
        ],
      }),
    ).toEqual([]);
  });

  it.each(['local_command', 'development'] as const)(
    'checks the declared %s backend instead of file readiness',
    (id) => {
      expect(
        taskSuggestionPreparations([{ ...task, readiness: [id] }], {
          capabilities: [
            { id: 'local_files', state: 'ready' },
            { id, state: 'paused' },
          ],
        }),
      ).toEqual(['bridge']);
    },
  );

  it.each(['busy', 'preparing'])(
    'does not turn temporary %s admission into a setup requirement',
    (state) => {
      expect(
        taskSuggestionPreparations([task], {
          capabilities: [{ id: 'local_browser', state }],
        }),
      ).toEqual([]);
    },
  );

  it('checks every declared local condition and deduplicates the shared entry', () => {
    expect(
      taskSuggestionPreparations(
        [task, { ...task, readiness: ['local_browser', 'local_command'] }],
        {
          capabilities: [
            { id: 'local_browser', state: 'ready' },
            { id: 'local_command', state: 'device_offline' },
          ],
        },
      ),
    ).toEqual(['bridge']);
  });

  it('uses file readiness only when the task has no declared conditions', () => {
    expect(
      taskSuggestionPreparations([{ ...task, readiness: undefined }], {
        capabilities: [{ id: 'local_files', state: 'ready' }],
      }),
    ).toEqual([]);
    expect(
      taskSuggestionPreparations([{ ...task, readiness: ['cloud_browser'] }], {
        capabilities: [
          { id: 'local_files', state: 'ready' },
          { id: 'cloud_browser', state: 'ready' },
        ],
      }),
    ).toEqual(['bridge']);
    expect(taskSuggestionPreparations([task], null)).toEqual(['bridge']);
  });
});
