import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AssistantResultSchema,
  type RequestContext,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import type { AssistantRuntime, AssistantWorkerLease } from '@allrice/database';
import { runtimePolicyDigest } from '@allrice/database';
import type { HarnessToolCall, HarnessToolResult } from '../adapter.js';

/** UUID derived from native call identity, stable across transport duplicates. */
function stableId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const text = z.string().trim().min(1).max(16000);
const tools = z.array(z.string().min(1).max(120)).max(64);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export interface AssistantWorkerBridgeOptions {
  runtime: AssistantRuntime;
  task: RuntimeTaskRef;
  context: RequestContext;
  worker: AssistantWorkerLease;
  wireNames: Readonly<Record<string, string>>;
  readOnlyTools: ReadonlySet<string>;
  supportedChildTools?: ReadonlySet<string>;
  proposalTools?: ReadonlySet<string>;
  onPublishOutput?: (input: {
    childRunId: string;
    deliveryId: string;
    output: { name: string; content: string };
  }) => Promise<{ artifactId: string; digest: string; relativePath: string }>;
  onRootTool?: (call: HarnessToolCall) => Promise<HarnessToolResult>;
  onReadTool?: (
    call: HarnessToolCall,
    childRunId: string,
  ) => Promise<HarnessToolResult>;
  /** Must submit the exact proposal to P04/Broker; never grants native approval.
   * Absent means side-effect proposals are unavailable, not automatically allowed. */
  onProposal?: (
    call: HarnessToolCall,
    childRunId: string,
  ) => Promise<HarnessToolResult>;
}
export function createAssistantWorkerBridge(
  options: AssistantWorkerBridgeOptions,
) {
  const { runtime, task, context, worker } = options;
  const base = { scope: task.scope, rootRunId: task.rootRunId, worker };
  const tree = () => runtime.getTree(context, { runId: task.rootRunId });
  async function lookup(nativeId: unknown) {
    const nativeSessionId = z
        .string()
        .regex(/^[a-zA-Z0-9_.-]{1,200}$/)
        .parse(nativeId),
      snapshot = await tree();
    const instance = snapshot.instances.find(
      (i) => i.nativeSessionId === nativeSessionId,
    );
    if (!instance) throw Error('assistant_identity_denied');
    return { instance, snapshot };
  }
  async function messageDispatch(inputId: string) {
    const claimed = await runtime.claimMessage({ ...base, inputId });
    const snapshot = await tree(),
      parent = snapshot.instances.find(
        (i) => i.runId === claimed.instance.parentRunId,
      );
    if (!parent) throw Error('assistant_parent_missing');
    return {
      dispatch: claimed.dispatch,
      instance: claimed.instance,
      inputId,
      text: claimed.message.text,
      parentNativeSessionId: parent.nativeSessionId,
      nativeSessionId: claimed.instance.nativeSessionId,
      maxDepth: snapshot.configuration.maxDepth,
      wireTools: claimed.instance.allowedTools
        .map((tool) => options.wireNames[tool])
        .filter((tool): tool is string => !!tool),
    };
  }
  const handle = async (
    method: string,
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const { instance, snapshot } = await lookup(p.nativeSessionId);
    if (method === 'checkpoint') {
      if (
        !snapshot.messages.some(
          (m) => m.inputId === p.inputId && m.childRunId === instance.runId,
        )
      )
        throw Error('assistant_message_recipient_mismatch');
      return runtime.checkpointMessage({
        ...base,
        inputId: z.uuid().parse(p.inputId),
        nativeMessageId: z.string().parse(p.nativeMessageId),
        ...(p.durableSeq === undefined
          ? {}
          : { durableSeq: natural.parse(p.durableSeq) }),
        ...(p.adoptedSeq === undefined
          ? {}
          : { adoptedSeq: natural.parse(p.adoptedSeq) }),
      });
    }
    if (method === 'model-prepare')
      return runtime.prepareModelUsage({
        ...base,
        runId: instance.runId,
        callId: z.uuid().parse(p.callId),
        requestedOutputTokens: natural.parse(p.outputTokens),
      });
    if (method === 'model-dispatch')
      return runtime.dispatchModelUsage({
        ...base,
        runId: instance.runId,
        callId: z.uuid().parse(p.callId),
        inputTokens: natural.parse(p.inputTokens),
        outputTokens: natural.parse(p.outputTokens),
        requestDigest: z.string().parse(p.requestDigest),
      });
    if (method === 'model-settle') {
      await runtime.settleUsage({
        ...base,
        runId: instance.runId,
        callId: z.uuid().parse(p.callId),
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          ...(p.inputTokens === undefined
            ? {}
            : { input_tokens: natural.parse(p.inputTokens) }),
          ...(p.outputTokens === undefined
            ? {}
            : { output_tokens: natural.parse(p.outputTokens) }),
        },
      });
      return { settled: true };
    }
    if (method === 'adopt-result') {
      await runtime.adoptResult({
        ...base,
        parentRunId: instance.runId,
        deliveryId: z.uuid().parse(p.deliveryId),
        nativeMessageId: z.string().parse(p.nativeMessageId),
        adoptedSeq: natural.parse(p.adoptedSeq),
      });
      return { adopted: true };
    }
    if (method === 'stopped') {
      await runtime.confirmStopped({ ...base, runId: instance.runId });
      return { stopped: true };
    }
    if (method === 'settled') {
      const existing = await runtime.resultDelivery({
        ...base,
        runId: instance.runId,
      });
      if (existing.result)
        return { ...existing.result, wakeParent: existing.wakeParent };
      const result = {
        deliveryId: stableId(`${instance.runId}:settled`),
        status: 'partial' as const,
        summary: 'Native assistant settled without a verified delivery.',
        evidence: [],
        incomplete: [
          `Native stop reason: ${String(p.stopReason).slice(0, 120)}`,
        ],
        usageComplete: false,
      };
      const recorded = await runtime.recordResult({
        ...base,
        runId: instance.runId,
        result,
      });
      return {
        ...result,
        status: recorded.status,
        wakeParent: recorded.wakeParent,
      };
    }
    const args = z.record(z.string(), z.unknown()).parse(p.arguments);
    const callId = z.string().min(1).max(240).parse(p.callId);
    const callUuid = stableId(`${instance.runId}:${callId}`);
    if (method === 'tool' || method === 'proposal') {
      const name = z.string().parse(p.name),
        parameters = z.record(z.string(), z.unknown()).parse(args);
      const isRoot = instance.parentRunId === null;
      const isProposal =
        method === 'proposal' || options.proposalTools?.has(name);
      const handler = isRoot
        ? options.onRootTool
        : isProposal
          ? options.onProposal
          : options.onReadTool;
      if (
        !handler ||
        (!isRoot && !isProposal && !options.readOnlyTools.has(name))
      )
        throw Error('assistant_tool_not_available');
      const reserved = await runtime.reserveUsage({
        ...base,
        runId: instance.runId,
        kind: 'tool',
        tool: name,
        nativeCall: {
          id: callId,
          argumentsDigest: runtimePolicyDigest(parameters),
        },
        ...(isProposal ? { proposal: true } : {}),
        callId: callUuid,
        amounts: {
          tool_calls: 1,
          model_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      });
      if (!reserved.reserved) throw Error('assistant_tool_unknown_no_replay');
      const result = await handler(
        { id: callId, name, arguments: parameters },
        instance.runId,
      );
      await runtime.settleUsage({
        ...base,
        callId: callUuid,
        runId: instance.runId,
        resultDigest: runtimePolicyDigest(result),
        amounts: {
          tool_calls: 1,
          model_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      });
      return { ...result };
    }
    if (!instance.allowedTools.includes(`assistant.${method}`))
      throw Error('assistant_tool_not_allowed');
    const meteringId = stableId(`${instance.runId}:${callId}:control`);
    await runtime.reserveUsage({
      ...base,
      runId: instance.runId,
      kind: 'tool',
      tool: `assistant.${method}`,
      callId: meteringId,
      amounts: {
        model_calls: 0,
        tool_calls: 1,
        input_tokens: 0,
        output_tokens: 0,
      },
    });
    try {
      if (method === 'delegate') {
        const selectedTools = tools.parse(args.tools);
        if (
          options.supportedChildTools &&
          selectedTools.some((tool) => !options.supportedChildTools!.has(tool))
        )
          throw Error('assistant_child_tool_not_supported');
        const { instance: child } = await runtime.provision({
          ...base,
          parentRunId: instance.runId,
          delegationId: callUuid,
          label: z.string().min(1).max(120).parse(args.label),
          text: text.parse(args.text),
          tools: selectedTools,
        });
        const dispatch = await messageDispatch(callUuid);
        return { ...dispatch, instance: child };
      }
      if (method === 'message') {
        const childRunId = z.uuid().parse(args.childRunId);
        if (
          !snapshot.instances.some(
            (i) => i.runId === childRunId && i.parentRunId === instance.runId,
          )
        )
          throw Error('assistant_parent_denied');
        await runtime.requestMessage(context, {
          runId: task.rootRunId,
          childRunId,
          inputId: callUuid,
          text: text.parse(args.text),
        });
        return messageDispatch(callUuid);
      }
      if (method === 'report') {
        const { output, ...report } = args;
        const result = AssistantResultSchema.parse({
          ...report,
          deliveryId: callUuid,
          usageComplete: false, // The database derives this from this child's settled calls.
        });
        if (output !== undefined) {
          if (!options.onPublishOutput)
            throw Error('assistant_output_unavailable');
          const published = await options.onPublishOutput({
            childRunId: instance.runId,
            deliveryId: callUuid,
            output: z
              .object({
                name: z.string().min(1).max(80),
                content: z.string().min(1).max(131072),
              })
              .strict()
              .parse(output),
          });
          await runtime.registerArtifact({
            ...base,
            runId: instance.runId,
            artifactId: published.artifactId,
            digest: published.digest,
            relativePath: published.relativePath,
          });
          result.evidence.push({
            id: published.artifactId,
            digest: published.digest,
          });
        }
        // This bounded coordination call is already known to have happened;
        // settle it before the database derives the child's truthful usage state.
        await runtime.settleUsage({
          ...base,
          runId: instance.runId,
          callId: meteringId,
          amounts: {
            tool_calls: 1,
            model_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        });
        const recorded = await runtime.recordResult({
          ...base,
          runId: instance.runId,
          result,
        });
        const delivery = await runtime.resultDelivery({
          ...base,
          runId: instance.runId,
        });
        return {
          ...delivery.result,
          wakeParent: recorded.wakeParent && delivery.wakeParent,
        };
      }
      if (method === 'stop') {
        const childRunId = z.uuid().parse(args.childRunId),
          child = snapshot.instances.find(
            (i) => i.runId === childRunId && i.parentRunId === instance.runId,
          );
        if (!child) throw Error('assistant_parent_denied');
        await runtime.cancelChild(context, {
          runId: task.rootRunId,
          childRunId,
          requestId: callUuid,
        });
        const descendants = new Set([childRunId]);
        for (let depth = 0; depth < 3; depth++)
          for (const i of snapshot.instances)
            if (i.parentRunId && descendants.has(i.parentRunId))
              descendants.add(i.runId);
        return {
          nativeSessionId: child.nativeSessionId,
          instances: snapshot.instances
            .filter((i) => descendants.has(i.runId))
            .reverse(),
        };
      }
      throw Error('assistant_method_not_allowed');
    } finally {
      await runtime.settleUsage({
        ...base,
        runId: instance.runId,
        callId: meteringId,
        amounts: {
          model_calls: 0,
          tool_calls: 1,
          input_tokens: 0,
          output_tokens: 0,
        },
      });
    }
  };
  return {
    handle,
    tree,
    messageDispatch,
    async cancellation() {
      // Admission-only checks cannot stop a provider stream after its grant is
      // revoked. Failure makes the adapter close only this already-owned host.
      await runtime.assertCurrentAuthority(base);
      const snapshot = await tree();
      return {
        nativeSessionId: snapshot.instances.find((i) => i.parentRunId === null)
          ?.nativeSessionId,
        instances: snapshot.instances
          .filter((i) => i.cancelRequestedAt && !i.stoppedAt)
          .reverse(),
      };
    },
  };
}
