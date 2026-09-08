// Synthetic subprocess fixture. Never imported by the Worker application.
import { CloudCommandSchema, cloudToolchainImageV1 } from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';

const attemptId = process.argv[2];
if (!attemptId || process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')
  throw Error('explicit synthetic integration only');
const command = CloudCommandSchema.parse({
  capability: 'cloud.process.execute',
  arguments: {
    script:
      "console.log('ready-to-stop-parent');setTimeout(()=>process.kill(1,'SIGSTOP'),250);setInterval(()=>{},100)",
    limits: { timeoutMs: 6000 },
  },
  backend: 'cloud-gvisor-v1',
  imageDigest: cloudToolchainImageV1,
  runtime: 'runsc',
  network: 'none',
});
await new CloudRunnerBackend().execute(command, [], {
  attemptId,
  deadlineAt: new Date(Date.now() + 10000).toISOString(),
  maintainLease: async () => true,
});
