import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  ModelGatewayError,
  MODEL_GATEWAY_CONTRACT_VERSION,
} from './contract.ts';
import type {
  ModelCallBinding,
  ModelGatewayAuthority,
  ModelGatewayPort,
  ModelGatewayStore,
  GatewayModelInput,
  GatewayProvider,
} from './contract.ts';
import type { PersonVmBinding } from '@allrice/person-vm';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMeteredTransport, installScopedFetch } from './transport.ts';

const inputKeys = [
  'messages',
  'system',
  'tools',
  'toolHistory',
  'temperature',
  'maxTokens',
  'stop',
  'reasoningEffort',
  'purpose',
];
export function decodeGatewayInput(value: unknown): GatewayModelInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ModelGatewayError('INVALID_INPUT');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !inputKeys.includes(key)) ||
    !Array.isArray(input.messages)
  )
    throw new ModelGatewayError('INVALID_INPUT');
  for (const message of input.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !['system', 'user', 'assistant', 'tool', 'developer'].includes(
        message.role,
      ) ||
      !Array.isArray(message.content)
    )
      throw new ModelGatewayError('INVALID_INPUT');
  }
  if (input.system !== undefined && typeof input.system !== 'string')
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.tools !== undefined &&
    (!Array.isArray(input.tools) ||
      input.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== 'string' ||
          typeof tool.description !== 'string' ||
          !tool.parameters ||
          typeof tool.parameters !== 'object' ||
          Array.isArray(tool.parameters),
      ))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== 'number' ||
      !Number.isFinite(input.temperature))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.maxTokens !== undefined &&
    (typeof input.maxTokens !== 'number' ||
      !Number.isSafeInteger(input.maxTokens) ||
      input.maxTokens <= 0)
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.stop !== undefined &&
    (!Array.isArray(input.stop) ||
      input.stop.some((s) => typeof s !== 'string'))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.reasoningEffort !== undefined &&
    typeof input.reasoningEffort !== 'string'
  )
    throw new ModelGatewayError('INVALID_INPUT');
  if (
    input.purpose !== undefined &&
    !['compaction', 'session-title'].includes(String(input.purpose))
  )
    throw new ModelGatewayError('INVALID_INPUT');
  // Message/tool semantics remain DSH's public contract. These checks enforce
  // the wire boundary, never infer intent, identity or permissions from content.
  return input as unknown as GatewayModelInput;
}

function assertBinding(b: ModelCallBinding): void {
  const strings = [
    b.vm.vmId,
    b.vm.personId,
    b.vm.organizationId,
    b.vm.instanceId,
    b.execution.runId,
    b.execution.executionId,
    b.employeeInstanceId,
    b.employeeRelease,
    b.allriceThreadRef,
    b.native.instanceId,
    b.native.profile,
    b.native.sessionId,
    b.native.rootSessionId,
    b.native.callId,
    b.executionGeneration,
    b.gatewayRelease,
    b.provider,
    b.model,
  ];
  if (
    strings.some((s) => typeof s !== 'string' || !s.trim()) ||
    !Number.isSafeInteger(b.vm.leaseEpoch) ||
    b.vm.leaseEpoch <= 0 ||
    b.context.actor.type !== 'user' ||
    b.context.actor.id !== b.vm.personId ||
    b.context.organizationId !== b.vm.organizationId ||
    (b.native.sessionId === b.native.rootSessionId) !==
      (b.native.parentSessionId === null) ||
    (b.native.parentSessionId !== null &&
      (!b.native.parentSessionId.trim() ||
        b.native.parentSessionId === b.native.sessionId))
  )
    throw new ModelGatewayError('BINDING_INVALID');
}
const vmKey = (vm: PersonVmBinding) =>
  JSON.stringify([
    vm.vmId,
    vm.personId,
    vm.organizationId,
    vm.instanceId,
    vm.leaseEpoch,
  ]);
async function readInput(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<GatewayModelInput> {
  const chunks: Buffer[] = [];
  const onAbort = () => request.destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request) {
      signal.throwIfAborted();
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  try {
    return decodeGatewayInput(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
  } catch (cause) {
    throw new ModelGatewayError('INVALID_INPUT', { cause });
  }
}
async function send(
  response: ServerResponse,
  chunk: StreamChunk,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed) throw new ModelGatewayError('ADMISSION_CLOSED');
  if (response.write(JSON.stringify(chunk) + '\n')) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      signal.removeEventListener('abort', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ModelGatewayError('ADMISSION_CLOSED'));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onClose, { once: true });
    if (signal.aborted) onClose();
  });
}

/** Inert until a trusted host explicitly creates and mounts it. */
export function createModelGateway(options: {
  ownerId: string;
  authority: ModelGatewayAuthority;
  store: ModelGatewayStore;
  provider: GatewayProvider;
}): ModelGatewayPort {
  if (!options.ownerId.trim()) throw new ModelGatewayError('BINDING_INVALID');
  const uninstall = installScopedFetch();
  const active = new Set<{
    key: string;
    controller: AbortController;
    done: Promise<void>;
  }>();
  let closed = false;
  const revoked = new Set<string>();
  return {
    async handle(request, response, bindingInput, hostSignal) {
      const controller = new AbortController();
      const signal = AbortSignal.any([hostSignal, controller.signal]);
      // Detach the immutable admission fact before the first await.
      let binding: ModelCallBinding;
      try {
        binding = JSON.parse(JSON.stringify(bindingInput)) as ModelCallBinding;
        assertBinding(binding);
      } catch {
        response.writeHead(403);
        response.end();
        return;
      }
      const key = vmKey(binding.vm);
      let finish!: () => void;
      const entry = {
        key,
        controller,
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
      };
      active.add(entry);
      const onClose = () => {
        if (!response.writableEnded)
          controller.abort(new Error('model_gateway_client_disconnected'));
      };
      response.on('close', onClose);
      const assertCurrent = async (currentSignal: AbortSignal) => {
        currentSignal.throwIfAborted();
        if (closed || revoked.has(key))
          throw new ModelGatewayError('ADMISSION_CLOSED');
        await options.authority.assertCall(binding, currentSignal);
        currentSignal.throwIfAborted();
      };
      let transport: ReturnType<typeof createMeteredTransport> | undefined;
      let iterator: AsyncIterator<StreamChunk> | undefined;
      let exhausted = false;
      try {
        await assertCurrent(signal);
        if (
          request.method !== 'POST' ||
          request.url !== '/v1/stream' ||
          request.headers['x-allrice-model-contract'] !==
            String(MODEL_GATEWAY_CONTRACT_VERSION)
        )
          throw new ModelGatewayError('INVALID_INPUT');
        const input = await readInput(request, signal);
        const digest =
          'sha256:' +
          createHash('sha256').update(JSON.stringify(input)).digest('hex');
        const callId = await options.store.claimCall(binding, digest);
        transport = createMeteredTransport({
          ...options,
          binding,
          callId,
          signal,
          assertCurrent,
        });
        iterator = transport.run(() => {
          const source = options.provider.stream(binding, input, signal);
          return source[Symbol.asyncIterator]();
        });
        response.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
          'x-allrice-model-contract': String(MODEL_GATEWAY_CONTRACT_VERSION),
        });
        let terminal: Extract<StreamChunk, { type: 'finish' }> | undefined;
        for (;;) {
          await assertCurrent(signal);
          const result = await transport.run(() => iterator!.next());
          if (result.done) {
            exhausted = true;
            break;
          }
          await assertCurrent(signal);
          if (result.value.type === 'finish') terminal = result.value;
          // Never forward provider-synthesized zeros, nor announce success
          // before the actual upstream body and durable receipt have settled.
          else if (result.value.type !== 'usage')
            await send(response, result.value, signal);
        }
        await transport.drain();
        await assertCurrent(signal);
        const attempts = (await options.store.attempts(callId)).filter(
          (a) => a.kind === 'model',
        );
        const last = attempts.at(-1);
        if (
          terminal &&
          (terminal.reason.kind === 'error' ||
            terminal.reason.kind === 'aborted')
        ) {
          const failure = terminal.reason.failure;
          await send(
            response,
            {
              ...terminal,
              reason: {
                kind: terminal.reason.kind,
                failure: new LlmError(
                  'Upstream model request failed',
                  failure.code,
                  {
                    ...(failure.status === undefined
                      ? {}
                      : { status: failure.status }),
                    ...(failure.providerRetryAfterMs === undefined
                      ? {}
                      : { providerRetryAfterMs: failure.providerRetryAfterMs }),
                    ...(failure.requestId === undefined
                      ? {}
                      : { requestId: failure.requestId }),
                  },
                ).failure,
              },
            },
            signal,
          );
          response.end();
          return;
        }
        if (
          !terminal ||
          !['stop', 'tool-calls', 'max-tokens'].includes(terminal.reason.kind)
        )
          throw new ModelGatewayError('PROVIDER_FAILED');
        if (
          !last ||
          last.outcome !== 'closed' ||
          last.httpStatus === null ||
          last.httpStatus < 200 ||
          last.httpStatus >= 300 ||
          last.terminal !== 'completed'
        )
          throw new ModelGatewayError('MISSING_UPSTREAM_TERMINAL');
        if (last.usage.usageComplete && last.usage.cacheUsageKnown) {
          const usage = last.usage;
          await send(
            response,
            {
              type: 'usage',
              usage: {
                inputTokens: usage.inputTokens! - usage.cachedInputTokens!,
                outputTokens: usage.outputTokens!,
                cacheReadTokens: usage.cachedInputTokens!,
                totalTokens: usage.totalTokens!,
              },
            },
            signal,
          );
        }
        await send(response, terminal, signal);
        response.end();
      } catch (error) {
        controller.abort(error);
        // Drain before any error response; a ledger failure supersedes an
        // apparently successful provider and keeps its unresolved DB lease.
        let code =
          error instanceof ModelGatewayError ? error.code : 'PROVIDER_FAILED';
        try {
          await transport?.drain();
        } catch {
          code = 'LEDGER_UNAVAILABLE';
        }
        if (!response.destroyed) {
          if (!response.headersSent)
            response.writeHead(
              code === 'DUPLICATE_CALL'
                ? 409
                : code === 'INVALID_INPUT'
                  ? 400
                  : code === 'AUTHORIZATION_DENIED'
                    ? 403
                    : 503,
              { 'content-type': 'application/x-ndjson' },
            );
          response.end(
            JSON.stringify({
              type: 'finish',
              reason: {
                kind: 'error',
                failure: new LlmError('Host model gateway request failed', code)
                  .failure,
              },
            }) + '\n',
          );
        }
      } finally {
        // Return the actual native iterator, after signal cancellation, and
        // await it. No detached producer may fetch again after admission closes.
        if (!exhausted && iterator) {
          controller.abort(new Error('model_gateway_iterator_closed'));
          try {
            await transport!.run(() => iterator!.return?.());
          } catch {
            /* original failure retained */
          }
        }
        try {
          await transport?.drain();
        } catch {
          /* already reported, unresolved lease retained */
        } finally {
          response.off('close', onClose);
          active.delete(entry);
          finish();
        }
      }
    },
    async revoke(binding) {
      const key = vmKey(binding);
      revoked.add(key);
      const entries = [...active].filter((entry) => entry.key === key);
      for (const entry of entries)
        entry.controller.abort(new Error('model_gateway_binding_revoked'));
      await Promise.all(entries.map((entry) => entry.done));
    },
    async reconcileOwner(context, ownerId, signal) {
      signal.throwIfAborted();
      const evidence = await options.authority.confirmOwnerStopped(
        context,
        ownerId,
        signal,
      );
      signal.throwIfAborted();
      if (!evidence.evidenceRef.trim())
        throw new ModelGatewayError('AUTHORIZATION_DENIED');
      return options.store.reconcileOwner(ownerId, evidence.evidenceRef);
    },
    async close() {
      closed = true;
      for (const entry of active)
        entry.controller.abort(new Error('model_gateway_closed'));
      await Promise.all([...active].map((entry) => entry.done));
      uninstall();
    },
    ledger: {
      async summarize(context, signal) {
        const identity = await options.authority.authorizeUsage(
          context,
          signal,
        );
        signal.throwIfAborted();
        if (
          context.actor.type !== 'user' ||
          identity.personId !== context.actor.id ||
          identity.organizationId !== context.organizationId
        )
          throw new ModelGatewayError('AUTHORIZATION_DENIED');
        return options.store.usage(identity.personId, identity.organizationId);
      },
    },
  };
}
