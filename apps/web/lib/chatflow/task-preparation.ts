import type {
  TaskSuggestionDisplay,
  WorkspaceCapabilityId,
} from '@allrice/contracts';

type Preparation = NonNullable<TaskSuggestionDisplay['preparation']>[number];
const localCapabilities = new Set<WorkspaceCapabilityId>([
  'local_files',
  'changeset',
  'local_command',
  'local_browser',
  'local_mcp',
  'development',
]);
const preparedStates = new Set(['ready', 'busy', 'preparing']);

/** Preparation guidance only. Temporary admission waits never disable a draft. */
export function taskSuggestionPreparations(
  tasks: readonly TaskSuggestionDisplay[],
  readiness: {
    capabilities: readonly { id: WorkspaceCapabilityId; state: string }[];
  } | null,
): Preparation[] {
  const state = (id: WorkspaceCapabilityId) =>
    readiness?.capabilities.find((capability) => capability.id === id)?.state;
  return [
    ...new Set(
      tasks.flatMap((task) =>
        (task.preparation ?? []).filter((preparation) => {
          if (preparation === 'files') return true;
          if (preparation === 'connections')
            return state('cloud_mcp') !== 'ready';
          const relevant = task.readiness?.length
            ? task.readiness.filter((id) => localCapabilities.has(id))
            : (['local_files'] as const);
          // A declaration containing only cloud conditions cannot establish that
          // an explicitly requested computer is prepared. Keep its guidance.
          return (
            !relevant.length ||
            relevant.some((id) => !preparedStates.has(state(id) ?? 'unknown'))
          );
        }),
      ),
    ),
  ];
}
