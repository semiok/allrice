import { testImage, testSocket } from './toolchain.js';
/** Synthetic dedicated-VM lifecycle fixture. Never invoked by shipped Bridge. */
import { readFile } from 'node:fs/promises';
import { LocalCommandRunner } from '../src/local-command-runner.js';
import { LocalServiceRunner } from '../src/local-service-runner.js';
import { BridgeJournal } from '../src/journal.js';
import { RuntimeBridgeDispatchSchema } from '@allrice/contracts';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  root: string;
  journal: string;
  dispatch: unknown;
};
const dispatch = RuntimeBridgeDispatchSchema.parse(config.dispatch);
if (
  dispatch.payload.capability !== 'local.process.execute' ||
  !dispatch.payload.arguments.background
)
  throw Error('service fixture required');
const journal = await BridgeJournal.open({
  directory: config.journal,
  server: 'https://tenant.example',
  deviceId: dispatch.snapshot.binding.execution.deviceId!,
});
await journal.receive(dispatch);
await journal.begin(dispatch.snapshot.binding.attempt.operationId);
const services = journal.serviceJournal();
const runner = new LocalCommandRunner({
  socketPath: testSocket,
  imageDigest: testImage,
});
const result = await new LocalServiceRunner(runner).execute(
  config.root,
  dispatch.payload,
  {
    processId: dispatch.snapshot.binding.attempt.operationId,
    attemptId: dispatch.snapshot.binding.attempt.attemptId,
    hardDeadlineAt: new Date(Date.now() + 30000).toISOString(),
    maintainLease: async () => ({
      leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
      inputs: [],
      stopRequested: false,
    }),
    prepareInput: (input) =>
      services.prepare(dispatch.snapshot.binding.attempt.operationId, input),
    onEvent: async (event) => {
      await services.event(
        dispatch.snapshot.binding.attempt.operationId,
        event,
      );
      process.send?.(event);
    },
  },
);
await journal.stopped(
  dispatch.snapshot.binding.attempt.operationId,
  result,
  'synthetic service ended',
);
await journal.close();
