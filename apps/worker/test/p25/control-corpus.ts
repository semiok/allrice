import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { format, resolveConfig } from 'prettier';

import type {
  NativeScheduleAnyControl,
  NativeScheduleControlReference,
  NativeScheduleWorkspaceSnapshot,
} from '../../src/native-schedule-once.js';
import {
  installSessions,
  normalizedCwd,
  sha256,
  type CorpusFile,
} from './journal-corpus.js';

/** Shared by the capture (dsh-control-journal-capture.test.ts) and the replay
 * test of the schedule control corpus (MET-221). A control
 * partition persists in two places: the control Sessions' DSH journals under
 * its stateRoot, and the SQL rows the controller reads through its store. The
 * corpus freezes both, as one release left them after a cold restore. */
export const controlCorpusDir = (contractDir: string) =>
  join(contractDir, 'control');

/** One frozen partition per control profile; the capture records the rest of
 * the reference (where it was born), the replay chooses a fresh stateRoot. */
export const controlProfiles = {
  once: 'allrice-once-control-v1',
  recurring: 'allrice-recurring-control-v1',
} as const;
export type ControlScenarioId = keyof typeof controlProfiles;

/** What the store returned to the next acquiring writer after the final
 * close: its controls, the stored Schedule task values and the workspace unit.
 * The capture's stateRoot is normalized like the journals' cwd. */
export interface ControlStoreImage {
  controls: NativeScheduleAnyControl[];
  tasks: Record<string, unknown>;
  workspace: NativeScheduleWorkspaceSnapshot;
}
export interface ControlScenario {
  id: ControlScenarioId;
  reference: Omit<NativeScheduleControlReference, 'stateRoot'>;
  files: CorpusFile[];
  store: CorpusFile;
}

/** Write the store image as committed bytes: the capture root normalized and
 * formatted as the repository formats JSON, so the recorded digest holds. */
export async function captureControlStore(
  root: string,
  output: string,
  scenario: ControlScenarioId,
  image: ControlStoreImage,
): Promise<CorpusFile> {
  const forms = [...new Set([await realpath(root), root])].sort(
    (a, b) => b.length - a.length,
  );
  const path = join(scenario, 'store.json');
  const target = join(output, path);
  const text = await format(
    forms.reduce(
      (value, form) => value.replaceAll(form, normalizedCwd),
      JSON.stringify(image),
    ),
    { ...(await resolveConfig(target)), filepath: target },
  );
  await writeFile(target, text, { flag: 'wx' });
  return { path, sha256: sha256(text) };
}

/** Install one frozen partition under a fresh stateRoot: its journals where
 * DSH derives them from that root, and its store image rebased onto it. Every
 * byte is checked against the manifest before anything is installed. */
export async function installControlCorpus(
  dir: string,
  scenario: ControlScenario,
  stateRoot: string,
): Promise<ControlStoreImage> {
  const text = await readFile(join(dir, scenario.store.path), 'utf8');
  if (sha256(text) !== scenario.store.sha256)
    throw new Error(`Corpus file changed: ${scenario.store.path}`);
  await installSessions(dir, scenario, stateRoot);
  return JSON.parse(text.replaceAll(normalizedCwd, stateRoot));
}
