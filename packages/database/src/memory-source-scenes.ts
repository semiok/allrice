import {
  EmployeeSceneStateSchema,
  type MemorySourceEvidence,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import type { ContentIdentity } from './content-maintenance.ts';
import { EmployeeContentError } from './employees/employee-content-model.ts';
import { personalSceneUseEnvelopeSchema } from './employees/personal-scene-reads.ts';
import {
  parsePersonalSceneContentRef,
  readPersonalSceneSkillInTransaction,
} from './employees/personal-scene-skills.ts';

export type MemorySourceSceneRun = {
  run_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  session_id: string;
  assistant_message_id: string | null;
  content_generation_id: string | null;
  content_scene_state: unknown;
  execution_snapshot: unknown;
};
type Scene = NonNullable<MemorySourceEvidence['scenes']>[number];
const unavailable = (): never => {
  throw new EmployeeContentError('source_changed');
};

/** Project existing exact reads and real native uses. A directory entry or
 * model assertion is never a read, and a read alone is never a native use. */
export async function readMemorySourceScenes(
  tx: TransactionSql,
  run: MemorySourceSceneRun,
  instanceId: string,
) {
  const state = EmployeeSceneStateSchema.safeParse(
    run.content_scene_state ?? { reads: [] },
  );
  if (!state.success) return unavailable();
  const snapshot = run.execution_snapshot as {
    content?: { personalScenes?: unknown };
  } | null;
  const personalMode = snapshot?.content?.personalScenes === true;
  const scenes: Scene[] = [];
  for (const receipt of state.data.reads) {
    const read = receipt.personal;
    if (!read) {
      if (personalMode) return unavailable();
      continue;
    }
    const pin = parsePersonalSceneContentRef(read.contentRef);
    if (
      read.runId !== run.run_id ||
      read.generationId !== run.content_generation_id ||
      read.instanceId !== instanceId ||
      !personalMode ||
      (!read.contentRead && !read.resources.length) ||
      pin.sceneId !== receipt.sceneId ||
      receipt.sceneDigest !== read.bundleChecksum ||
      scenes.some(
        (scene) => scene.receipt.personal.contentRef === read.contentRef,
      )
    )
      return unavailable();
    scenes.push({
      runId: run.run_id,
      receipt: { ...receipt, personal: read },
      uses: [],
    });
  }
  const events = await tx<
    { id: string; payload: unknown; bound_session_id: string | null }[]
  >`select e.id,e.payload,b.native_session_id as bound_session_id
    from allrice_run_events e
    left join allrice_native_session_bindings b
      on b.native_session_id=e.payload#>>'{nativePayload,nativeSessionId}'
      and b.organization_id=${run.organization_id} and b.workspace_id=${run.workspace_id}
      and b.owner_id=${run.owner_id} and b.context_kind='chat'
      and b.context_id::text=e.payload->>'conversationId'
    where e.organization_id=${run.organization_id} and e.workspace_id=${run.workspace_id}
      and e.run_id=${run.run_id} and e.event_type='harness.native'
      and e.payload->>'sourceEventType'='allrice/scene-use'
    order by e.sequence,e.id limit 65`;
  for (const event of events.slice(0, 64)) {
    const parsed = personalSceneUseEnvelopeSchema.safeParse(event.payload);
    if (!parsed.success) return unavailable();
    const envelope = parsed.data,
      use = envelope.nativePayload,
      scene = scenes.find(
        (item) => item.receipt.personal.contentRef === use.contentRef,
      );
    if (
      !scene ||
      !scene.receipt.personal.contentRead ||
      scene.receipt.sceneId !== use.sceneId ||
      scene.receipt.personal.contentChecksum !== use.contentChecksum ||
      scene.receipt.personal.bundleChecksum !== use.bundleChecksum ||
      envelope.threadId !== use.nativeSessionId ||
      event.bound_session_id !== use.nativeSessionId ||
      envelope.conversationId !== run.session_id ||
      envelope.messageId !== run.assistant_message_id ||
      envelope.sourceEventId !==
        `scene-use:${use.nativeSessionId}:${use.nativeSequence}`
    )
      return unavailable();
    scene.uses.push({ eventId: event.id, use });
  }
  return { scenes, truncated: events.length > 64 };
}

/** Reuse the exact historical reader's current publication/source/ACL checks.
 * No content or identity SHARE locks: background capture must not hold up a
 * human revocation. Call again at the end of the ledger write savepoint. */
export async function assertMemorySourceScenesAvailable(
  tx: TransactionSql,
  context: ContentIdentity & { requestId: string },
  instanceId: string,
  scenes: Scene[],
) {
  for (const { receipt, uses } of scenes) {
    const read = receipt.personal;
    const pkg = await readPersonalSceneSkillInTransaction(
      context,
      instanceId,
      { contentRef: read.contentRef },
      tx,
      false,
    );
    if (
      pkg.skill.sceneId !== receipt.sceneId ||
      pkg.skill.contentChecksum !== read.contentChecksum ||
      pkg.skill.bundleChecksum !== read.bundleChecksum ||
      read.resources.some(
        (resource) =>
          !pkg.skill.resources.some(
            (item) =>
              item.path === resource.path &&
              item.checksum === resource.checksum,
          ),
      ) ||
      uses.some(
        ({ use }) =>
          use.revision !== pkg.skill.revision ||
          (use.nativeName !== pkg.skill.nativeName &&
            use.nativeName !== `allrice-scene-${receipt.sceneId}`),
      )
    )
      return unavailable();
  }
}
