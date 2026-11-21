import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  SlotCore,
  type LiveCompositionNode,
  type PropsRenderSlots,
} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { expect, it, vi } from 'vitest';

interface Recorder {
  markStage(name: string): void;
  dispose(): void;
  diagnostics(): {
    stage: string;
    settingsTree: LiveCompositionNode[];
    checkpoints: { stage: string; settingsTree: LiveCompositionNode[] }[];
    entryErrors: {
      stage: string;
      slot: string;
      message: string;
      abdicated: boolean;
    }[];
  };
}

// Load the shipped fixture factory without applying its Host/business plugin.
let createRecorder: (slots: SlotCore) => Recorder;
runInNewContext(
  readFileSync(
    new URL('./fixtures/settings-integration-client.js', import.meta.url),
    'utf8',
  ),
  {
    window: {
      __ModuleLoader__: {
        load(module: {
          factory(require: (name: string) => object): {
            createLifecycleRecorder: typeof createRecorder;
          };
        }) {
          createRecorder = module.factory(() => ({})).createLifecycleRecorder;
        },
      },
    },
  },
);

function setup() {
  const slots = new SlotCore();
  const removeRoot = slots.register(
    {
      name: 'root',
      children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
    },
    (props: PropsRenderSlots<'sidebar.settings'>) => {
      void props;
      return null;
    },
  );
  slots.register(
    {
      name: 'sidebar.settings',
      children: { 'settings.trigger': { kind: 'single', scope: 'root' } },
      registrant: 'synthetic-settings-shell',
    },
    (props: PropsRenderSlots<'settings.trigger'>) => {
      void props;
      return null;
    },
  );
  slots.register({ name: 'settings.trigger' }, () => null);
  return { slots, removeRoot, recorder: createRecorder(slots) };
}

it('records detached native slot snapshots without mutating registrations or versions', () => {
  const { slots, removeRoot, recorder } = setup();
  const originalTree = slots.snapshot('sidebar.settings');
  const originalEntries = slots.entries('sidebar.settings');
  const version = slots.getVersion('sidebar.settings');
  recorder.markStage('unload:before');
  const before = recorder.diagnostics();
  expect(before.settingsTree).toEqual(originalTree);
  expect(slots.entries('sidebar.settings')).toBe(originalEntries);
  expect(slots.getVersion('sidebar.settings')).toBe(version);

  removeRoot();
  recorder.markStage('unload:after');
  const after = recorder.diagnostics();
  expect(after.settingsTree).toEqual([]);
  expect(after.checkpoints[0]?.settingsTree).toEqual(originalTree);
  expect(before.settingsTree).toEqual(originalTree);
  expect(after.checkpoints.map(({ stage }) => stage)).toEqual([
    'unload:before',
    'unload:after',
  ]);
  expect(() => JSON.stringify(after)).not.toThrow();
  recorder.dispose();
});

it('attributes native errors to the current stage without consuming reports or changing abdication', () => {
  const { slots, recorder } = setup();
  const observer = vi.fn();
  const stopObserver = slots.onEntryError(observer);
  const entry = slots.entries('sidebar.settings')[0]!;
  const error = new Error('synthetic stale frame');
  recorder.markStage('unload:before');
  slots.reportEntryError('sidebar.settings', entry, error, { abdicate: true });
  expect(observer).toHaveBeenCalledWith('sidebar.settings', entry, error, {
    abdicated: true,
  });
  expect(slots.entriesOfSlot('sidebar.settings')).toEqual([]);
  expect(slots.entries('sidebar.settings')).toContain(entry);
  expect(recorder.diagnostics().entryErrors).toMatchObject([
    {
      stage: 'unload:before',
      slot: 'sidebar.settings',
      message: 'Error: synthetic stale frame',
      abdicated: true,
    },
  ]);

  recorder.dispose();
  slots.reportEntryError('sidebar.settings', entry, error, { abdicate: false });
  expect(observer).toHaveBeenCalledTimes(2);
  expect(recorder.diagnostics().entryErrors).toHaveLength(1);
  stopObserver();
});
