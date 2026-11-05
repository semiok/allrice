import { readDshToolResult } from '@allrice/contracts/native-runtime';
import { createHash } from 'node:crypto';
import { renderSkillContent } from '@deepseek-ai/dsh-skill';
import {
  PersonalSceneSkillSchema,
  PersonalSceneUseSchema,
  PersonalSceneSkillCatalogSchema,
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
  async function load(scene, signal, nativeSessionId = ctx.agents?.requireInitiator().id) {
    signal?.throwIfAborted();
    const loaded = await bridge(
      'load',
      { sceneId: scene.id, sceneDigest: scene.digest, ...(nativeSessionId ? { nativeSessionId } : {}) },
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
    loadedSkills.set(`${nativeSessionId ?? ''}:${scene.nativeName}`, {
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
          const readKey = `${session.id}:${name}`;
          if (!loadedSkills.has(readKey)) await load(scene, undefined, session.id);
          const loaded = loadedSkills.get(readKey);
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

/** Native registry over the current personal library. DB owns authorization and
 * durable actual-read evidence; neither reload nor cold recovery replays loads. */
export function installPersonalSceneProvider(ctx, bridge) {
  let control;
  const personalInvocation = Object.freeze({
    modelInvocable: true,
    userInvocable: true,
  });
  // Correlate only live public events with bytes just returned by this Provider.
  // This is ephemeral audit correlation, not a content/version cache. Restored
  // or fork-inherited history never becomes a new Run's use claim.
  const loadedByRendering = new Map(),
    calls = new Map();
  const renderKey = (text) =>
    typeof text === 'string'
      ? createHash('sha256').update(text).digest('hex')
      : undefined;
  let pending = Promise.resolve(),
    failure;
  const track = (promise) => {
    pending = Promise.all([pending, promise])
      .then(() => undefined)
      .catch((error) => {
        failure ??= error;
      });
  };
  ctx.skills.registerProvider((registration) => {
    control = registration;
    return {
      name: providerName,
      list: async (options) => {
        const catalog = PersonalSceneSkillCatalogSchema.parse(
          await bridge('personal-list', {}, options?.signal),
        );
        return catalog.skills.map((skill) => ({
          name: skill.nativeName,
          description: `工作场景：${skill.name}。适用：${skill.description}`,
          invocation: personalInvocation,
          provider: providerName,
          source: 'allrice-managed',
          rank: 100,
          locator: { id: skill.sceneId },
        }));
      },
      get: async (candidate, options) => {
        if (candidate.name !== `allrice-scene-${candidate.locator?.id}`)
          return undefined;
        options?.signal?.throwIfAborted();
        const skill = PersonalSceneSkillSchema.parse(
          await bridge(
            'personal-load',
            { sceneId: candidate.locator.id },
            options?.signal,
          ),
        );
        options?.signal?.throwIfAborted();
        if (
          skill.sceneId !== candidate.locator.id ||
          skill.nativeName !== candidate.name
        )
          throw Error('employee_scene_receipt_invalid');
        const definition = {
          name: skill.nativeName,
          description: `工作场景：${skill.name}。适用：${skill.description}`,
          invocation: personalInvocation,
          provider: providerName,
          source: 'allrice-managed',
          content: skill.content,
          resourceBase: {
            kind: 'opaque',
            description: `AllRice Workflow resources: use workspace_skill_read with contentRef=${JSON.stringify(skill.contentRef)} and path. Exact package ${skill.bundleChecksum}; content ${skill.contentChecksum}. Resources: ${JSON.stringify(skill.resources)}. Read only; scripts are not executed.`,
          },
        };
        loadedByRendering.set(renderKey(renderSkillContent(definition)), skill);
        return definition;
      },
    };
  });
  ctx.on('session/event', (session, event) => {
    if (event.surfaceOp === 'replace' || event.surfaceOp?.op === 'replace')
      return;
    const data = event.data;
    if (event.type === 'tool/call' && data.name === 'skill') {
      let args = data.arguments;
      try {
        if (typeof args === 'string') args = JSON.parse(args);
      } catch {
        return;
      }
      if (typeof args?.name === 'string')
        calls.set(`${session.id}:${data.callId}`, args.name);
      return;
    }
    let name, text, kind, nativeId;
    if (
      event.type === 'user/message' &&
      data.source?.kind === 'skill-invocation' &&
      data.source.form === 'instructions'
    ) {
      name = data.source.name;
      text = output({ content: data.content });
      kind = 'skill-invocation';
      nativeId = data.id;
    } else if (event.type === 'tool/result') {
      const block = readDshToolResult(data.message);
      nativeId =
        block?.toolCallId ?? data.message?.toolCallId ?? data.message?.callId;
      const key = `${session.id}:${nativeId}`;
      name = calls.get(key);
      calls.delete(key);
      if (data.error || block?.isError === true) return;
      text = output(block);
      kind = 'tool-result';
    } else return;
    const loaded = loadedByRendering.get(renderKey(text));
    if (!loaded || loaded.nativeName !== name) return;
    const evidence = PersonalSceneUseSchema.parse({
      sceneId: loaded.sceneId,
      nativeName: loaded.nativeName,
      contentRef: loaded.contentRef,
      revision: loaded.revision,
      contentChecksum: loaded.contentChecksum,
      bundleChecksum: loaded.bundleChecksum,
      nativeSessionId: session.id,
      nativeSequence: event.seq,
      kind,
      nativeId,
    });
    track(bridge('personal-use', evidence));
  });
  return {
    invalidate: () => {
      // Worker prompt admission is the next root input boundary. Never replay
      // a previous Run's reads as this Run's injection evidence.
      loadedByRendering.clear();
      calls.clear();
      control.invalidate();
    },
    // Invalidate the native catalog for the next pre-step. Body get has no
    // cache. Historical reads are checked by the same durable content guard.
    async beforeDispatch() {
      let observed;
      do {
        observed = pending;
        await observed;
      } while (observed !== pending);
      if (failure) throw failure;
      control.invalidate();
    },
  };
}
