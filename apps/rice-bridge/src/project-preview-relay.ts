import { ContainerProjectPreviewRelay } from '@allrice/project-runtime';
import type { LocalCommandRunner } from './local-command-runner.js';
import type { BridgeJournal } from './journal.js';
import { currentLocalProjectService } from './local-process-manager.js';
/** Backend adapter only; HTTP/WS buffering and fixed loopback exec are shared. */
export class ProjectPreviewRelay extends ContainerProjectPreviewRelay {
  constructor(runner: LocalCommandRunner, journal: BridgeJournal) {
    super({
      api: runner.api,
      alive: (target) => !!currentLocalProjectService(journal, target),
      assertTarget: async (target) => {
        const command = currentLocalProjectService(journal, target);
        if (!command || !runner.projects)
          throw Error('PROJECT_PREVIEW_REVOKED');
        await runner.projects.assertServiceTarget(
          target.attemptId,
          target.containerId,
          command,
          target.serviceId,
        );
      },
    });
  }
}
