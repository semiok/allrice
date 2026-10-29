import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const sha = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
// MET-219, seen on Dev root d6bad738: the user stopped child A while its model
// stream was in flight. The aborted call keeps its whole output reservation
// (its usage is unknown), Rice then ends with an empty reply, and the checked
// delivery repair must still be allowed to write the final answer.
integration(
  'P25 checked delivery repair after a stopped child (production controller + PostgreSQL)',
  () => {
    let database: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createRuntimeFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
  },
);
