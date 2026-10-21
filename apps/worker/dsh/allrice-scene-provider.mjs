import { readDshToolResult } from '@allrice/contracts/native-runtime';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import {
  EmployeeRuntimeSceneSchema,
  EmployeeSceneReadSchema,
} from '@allrice/contracts/native-runtime';

const providerName = 'allrice-scenes';
const resourcePrefix = 'AllRice scene receipt: ';
const invocation = Object.freeze({
  modelInvocable: true,
  userInvocable: false,
});
function output(block) {
  const raw = block?.output ?? block?.content ?? block?.result;
  const text =
    Array.isArray(raw) && raw.every((b) => b?.type === 'text')
      ? raw.map((b) => b.text).join('\n')
      : raw;
  return typeof text === 'string' ? text : undefined;
}

/** Uses the native skill registry and native tool events. It neither grants a
 * tool nor installs an alternative agent/skill runner. */
export function installSceneProvider(ctx, rawScenes, bridge) {
  const scenes = rawScenes.map((s) => EmployeeRuntimeSceneSchema.parse(s));
  if (
    scenes.length > 16 ||
    new Set(scenes.map((s) => s.id)).size !== scenes.length
  )
    throw Error('employee_scene_directory_invalid');
  const byName = new Map(scenes.map((s) => [s.nativeName, s]));
  const calls = new Map(),
    loadedSkills = new Map(),
    hydrated = new WeakSet(),
    successful = new Set();
  let pending = Promise.resolve(),
    failure;
  function track(p) {
    pending = Promise.all([pending, p])
      .then(() => undefined)
      .catch((e) => {
        failure ??= e;
      });
  }
  async function load(scene, signal) {
    signal?.throwIfAborted();
    const loaded = await bridge(
      'load',
      { sceneId: scene.id, sceneDigest: scene.digest },
      signal,
    );
    signal?.throwIfAborted();
    const receipt = EmployeeSceneReadSchema.parse(loaded.receipt);
    if (
      receipt.sceneId !== scene.id ||
      receipt.sceneDigest !== scene.digest ||
      typeof loaded.content !== 'string'
    )
      throw Error('employee_scene_receipt_invalid');
    const skill = {
      name: scene.nativeName,
      description: `工作场景：${scene.name}`,
      invocation,
      provider: providerName,
      source: 'allrice-managed',
      content: loaded.content,
      // The canonical native renderer includes this opaque resource hint.
      resourceBase: {
        kind: 'opaque',
        description: `${resourcePrefix}${JSON.stringify(receipt)}`,
      },
    };
    loadedSkills.set(scene.nativeName, {
      skill,
      receipt,
      rendered: renderSkillContent(skill),
    });
    return skill;
  }
  ctx.skills.registerProvider(() => ({
    name: providerName,
    list: async () =>
      scenes.map((s) => ({
        name: s.nativeName,
        description: `工作场景：${s.name}。适用：${s.appliesWhen}`,
        invocation,
        provider: providerName,
        source: 'allrice-managed',
        rank: 100,
        locator: { id: s.id, digest: s.digest },
      })),
    get: async (candidate, options) => {
      const scene = byName.get(candidate.name);
      if (
        !scene ||
        candidate.locator?.id !== scene.id ||
        candidate.locator?.digest !== scene.digest
      )
        return undefined;
      return load(scene, options?.signal);
    },
  }));
  function observe(session, event) {
    if (event.surfaceOp === 'replace' || event.surfaceOp?.op === 'replace')
      return;
    const d = event.data;
    if (event.type === 'tool/call' && d.name === 'skill') {
      let args = d.arguments;
      try {
        if (typeof args === 'string') args = JSON.parse(args);
      } catch {
        return;
      }
      if (!byName.has(args?.name)) return;
      if (calls.size >= 128) {
        failure ??= Error('employee_scene_inflight_limit');
        return;
      }
      calls.set(`${session.id}:${d.callId}`, args.name);
    } else if (event.type === 'tool/result') {
      const block = readDshToolResult(d.message);
      const callId =
        block?.toolCallId ?? d.message?.toolCallId ?? d.message?.callId;
      const key = `${session.id}:${callId}`,
        name = calls.get(key);
      calls.delete(key);
      if (!name || d.error || block?.isError === true) return;
      if (successful.has(key)) return;
      if (successful.size >= 1024) {
        failure ??= Error('employee_scene_receipt_limit');
        return;
      }
      successful.add(key);
      const value = output(block),
        scene = byName.get(name);
      track(
        (async () => {
          // Cold recovery has no in-memory get receipt. Reload the same frozen
          // scene through Worker, which must reauthorize and return the durable
          // receipt, then compare the canonical native rendering exactly.
          if (!loadedSkills.has(name)) await load(scene);
          const loaded = loadedSkills.get(name);
          if (value !== loaded.rendered)
            throw Error('employee_scene_native_result_invalid');
          await bridge('adopt', {
            ...loaded.receipt,
            nativeSessionId: session.id,
            callId,
          });
        })(),
      );
    }
  }
  ctx.on('session/event', observe);
  return {
    async beforeDispatch(nativeSessionId) {
      const session = ctx.sessions.get(nativeSessionId);
      if (!session) throw Error('employee_scene_session_unavailable');
      if (!hydrated.has(session)) {
        hydrated.add(session);
        // Root and child resume both restore the public Session, without
        // emitting its seed events. Exclude fork-inherited parent receipts.
        for (const event of session.ownEvents()) observe(session, event);
      }
      let observed;
      do {
        observed = pending;
        await observed;
      } while (observed !== pending);
      if (failure) throw failure;
    },
  };
}
