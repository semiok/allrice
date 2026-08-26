import {
  formatSseCursor,
  ChatFlowEventEnvelopeSchema,
  isTerminalRunStatus,
  parseSseCursor,
  type RequestContext,
  type RunEvent,
} from '@allrice/contracts';
import {
  DataAccessError,
  QueueError,
  getRun,
  getDatabase,
  listRunEvents,
  subscribeChatFlowWakeups,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { chatFlowRealtimeEnabled } from '../../../../../../lib/chatflow/rollout';
import { incrementChatFlowMetric } from '../../../../../../lib/chatflow/metrics';
import { createChatFlowWaiter } from '../../../../../../lib/chatflow/waiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function chatFlowEnvelope(input: {
  event: RunEvent;
  context: RequestContext;
  workspaceId: string;
}) {
  const payload =
    input.event.payload !== null &&
    typeof input.event.payload === 'object' &&
    !Array.isArray(input.event.payload)
      ? (input.event.payload as Record<string, unknown>)
      : { value: input.event.payload };
  const source = payload.source;
  const generation = payload.generation;
  const sourceEventId = payload.sourceEventId;
  const sourceEventType = payload.sourceEventType;
  const sourceOccurredAt = payload.sourceOccurredAt;
  const nativePayload = payload.nativePayload;
  return ChatFlowEventEnvelopeSchema.parse({
    schemaVersion: 2,
    eventId: input.event.eventId,
    organizationId: input.context.organizationId,
    workspaceId: input.workspaceId,
    conversationId:
      typeof payload.conversationId === 'string'
        ? payload.conversationId
        : null,
    runId: input.event.runId,
    generation:
      typeof generation === 'number' && Number.isInteger(generation)
        ? generation
        : null,
    cursor: formatSseCursor({
      runId: input.event.runId,
      sequence: input.event.sequence,
    }),
    sequence: input.event.sequence,
    harness: source === 'codex' || source === 'dsh' ? source : null,
    type: input.event.type,
    occurredAt: input.event.occurredAt,
    sourceEvent:
      typeof sourceEventId === 'string' &&
      typeof sourceEventType === 'string' &&
      typeof sourceOccurredAt === 'string'
        ? {
            id: sourceEventId,
            type: sourceEventType,
            occurredAt: sourceOccurredAt,
            payload:
              nativePayload !== null &&
              typeof nativePayload === 'object' &&
              !Array.isArray(nativePayload)
                ? (nativePayload as Record<string, unknown>)
                : {},
          }
        : null,
    payload,
  });
}

function encodedEvent(
  event: RunEvent,
  context: RequestContext,
  workspaceId: string,
  nativeContract: boolean,
) {
  const data = nativeContract
    ? chatFlowEnvelope({ event, context, workspaceId })
    : event;
  return [
    `id: ${formatSseCursor({ runId: event.runId, sequence: event.sequence })}`,
    `event: ${nativeContract ? 'chatflow-event' : 'run-event'}`,
    `data: ${JSON.stringify(data)}`,
    '',
    '',
  ].join('\n');
}

async function streamEvents(input: {
  controller: ReadableStreamDefaultController<Uint8Array>;
  request: Request;
  context: RequestContext;
  workspaceId: string;
  runId: string;
  initialEvents: RunEvent[];
  afterSequence: number;
  preferNotify: boolean;
  nativeContract: boolean;
}) {
  const encoder = new TextEncoder();
  let sequence = input.afterSequence;
  let pending = input.initialEvents;
  let lastHeartbeat = Date.now();
  const waiter = createChatFlowWaiter();
  let unsubscribe: (() => void) | null = null;
  let notifyActive = false;
  try {
    if (input.preferNotify) {
      try {
        unsubscribe = await subscribeChatFlowWakeups(
          getDatabase(),
          input.runId,
          () => {
            incrementChatFlowMetric('wakeups');
            waiter.signal();
          },
        );
        notifyActive = true;
        incrementChatFlowMetric('postgresNotifyConnections');
      } catch (error) {
        incrementChatFlowMetric('notifyFallbacks');
        console.error(
          '[ChatFlow] PostgreSQL notification subscription failed',
          {
            runId: input.runId,
            message: error instanceof Error ? error.message : 'unknown error',
          },
        );
      }
    }
    if (!notifyActive) incrementChatFlowMetric('pollingConnections');
    while (!input.request.signal.aborted) {
      for (const event of pending) {
        input.controller.enqueue(
          encoder.encode(
            encodedEvent(
              event,
              input.context,
              input.workspaceId,
              input.nativeContract,
            ),
          ),
        );
        sequence = event.sequence;
        incrementChatFlowMetric('eventsDelivered');
      }
      const run = await getRun(input.context, input.workspaceId, input.runId);
      const nextEvents = await listRunEvents(
        input.context,
        input.workspaceId,
        input.runId,
        sequence,
      );
      if (nextEvents.length > 0) {
        pending = nextEvents;
        continue;
      }
      if (isTerminalRunStatus(run.status)) break;
      if (Date.now() - lastHeartbeat >= 15_000) {
        input.controller.enqueue(encoder.encode(': heartbeat\n\n'));
        lastHeartbeat = Date.now();
      }
      if (notifyActive) {
        const wakeup = await waiter.wait(5_000, input.request.signal);
        if (wakeup === 'aborted') break;
        if (wakeup === 'timeout') incrementChatFlowMetric('safetyPolls');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      pending = await listRunEvents(
        input.context,
        input.workspaceId,
        input.runId,
        sequence,
      );
    }
    input.controller.close();
  } catch (error) {
    if (!input.request.signal.aborted) {
      input.controller.error(error);
    }
  } finally {
    unsubscribe?.();
  }
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    await getRun(context, workspaceId, id);
    const lastEventId = request.headers.get('last-event-id');
    let afterSequence = -1;
    if (lastEventId) {
      try {
        const cursor = parseSseCursor(lastEventId);
        if (cursor.runId !== id) throw new QueueError('cursor_invalid');
        afterSequence = cursor.sequence;
      } catch (error) {
        if (error instanceof QueueError) throw error;
        throw new QueueError('cursor_invalid');
      }
    }
    const initialEvents = await listRunEvents(
      context,
      workspaceId,
      id,
      afterSequence,
    );
    const harness = initialEvents
      .map((event) =>
        event.payload && typeof event.payload === 'object'
          ? (event.payload as { source?: unknown }).source
          : null,
      )
      .find((source) => source === 'codex' || source === 'dsh');
    const preferNotify = chatFlowRealtimeEnabled({
      organizationId: context.organizationId,
      workspaceId,
      harness: harness === 'codex' || harness === 'dsh' ? harness : null,
    });
    const nativeContract =
      new URL(request.url).searchParams.get('contract') === 'chatflow-v2';
    if (
      new URL(request.url).searchParams.get('format') === 'json' ||
      request.headers.get('accept')?.includes('application/json')
    ) {
      return Response.json({
        events: nativeContract
          ? initialEvents.map((event) =>
              chatFlowEnvelope({ event, context, workspaceId }),
            )
          : initialEvents,
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void streamEvents({
          controller,
          request,
          context,
          workspaceId,
          runId: id,
          initialEvents,
          afterSequence,
          preferNotify,
          nativeContract,
        });
      },
    });
    incrementChatFlowMetric('connections');
    if (lastEventId) incrementChatFlowMetric('reconnects');
    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
        'x-allrice-chatflow-version': '2',
        'x-allrice-chatflow-event-contract': nativeContract
          ? 'chatflow-native-v2'
          : 'run-event-v1',
        'x-allrice-chatflow-transport': preferNotify
          ? 'postgres-notify'
          : 'polling',
      },
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
