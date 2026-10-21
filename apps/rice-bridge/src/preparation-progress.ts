/** Local diagnostic labels only: no URLs, paths, command lines or credentials. */
export const preparationComponents = [
  'vm',
  'python',
  'node',
  'browser',
  'pdf',
  'command',
] as const;
export const preparationSteps = [
  'download',
  'verify_download',
  'extract',
  'vm_wait',
  'vm_start',
  'vm_stop',
  'vm_status',
  'engine_socket',
  'engine_info',
  'image_check',
  'image_import',
  'probe_create',
  'probe_start',
  'probe_logs',
  'probe_inspect',
  'probe_cleanup',
  'browser_prepare',
  'pdf_prepare',
  'command_prepare',
] as const;
export type PreparationComponent = (typeof preparationComponents)[number];
export type PreparationStep = (typeof preparationSteps)[number];
export interface PreparationEvent {
  component: PreparationComponent;
  step: PreparationStep;
  state: 'started' | 'completed' | 'failed';
}
export type PreparationObserver = (event: PreparationEvent) => void;

/** Diagnostics cannot prevent cancellation, cleanup, or completion. */
export async function withPreparationStep<T>(
  observer: PreparationObserver | undefined,
  component: PreparationComponent,
  step: PreparationStep,
  operation: () => Promise<T>,
): Promise<T> {
  const emit = (state: PreparationEvent['state']) => {
    try {
      observer?.({ component, step, state });
    } catch {
      /* diagnostic only */
    }
  };
  emit('started');
  try {
    const value = await operation();
    emit('completed');
    return value;
  } catch (error) {
    emit('failed');
    throw error;
  }
}
