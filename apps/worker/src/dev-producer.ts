import {
  DevMaintenanceError,
  type DevProducerContext,
  type installDevProducerLifecycle,
} from '@allrice/database';

type Lifecycle = Awaited<ReturnType<typeof installDevProducerLifecycle>>;

/** Shutdown may begin during durable admission. Check again after admission
 * before invoking any producer, rather than relying on a timer's early check. */
export function workerProducerRunner(
  lifecycle: Pick<Lifecycle, 'run'>,
  stopping: () => boolean,
) {
  return async (
    producer: Parameters<Lifecycle['run']>[0],
    body: (context: DevProducerContext) => Promise<unknown>,
  ) => {
    try {
      await lifecycle.run(producer, async (context) => {
        if (stopping()) return;
        await body(context);
      });
    } catch (error) {
      if (!(
        error instanceof DevMaintenanceError &&
        error.code === 'dev_maintenance_requested'
      ))
        throw error;
    }
  };
}
