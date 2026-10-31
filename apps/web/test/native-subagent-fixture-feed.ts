import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createNativeSubagentFollowGateway } from '../server/native-subagent-follow.mjs';
import type { Page } from '../../worker/node_modules/playwright-core/index.js';
import type {
  NativeSubagentFollowEvent,
  NativeSubagentSummary,
  ChatFlowEventEnvelope,
} from '@allrice/contracts';
import type { NativeSubagentSnapshot } from '../app/chatflow/native-subagent-follow';

export function snapshotFor(
  summary: NativeSubagentSummary,
  childId: string,
): NativeSubagentSnapshot {
  const child = summary.descendants.find((entry) => entry.id === childId);
  if (!child || child.kind !== 'child') throw Error('fixture child missing');
  return {
    rootId: summary.rootId,
    childId,
    hostEpoch: 1,
    observation: { source: 'live', cursor: 8 },
    inheritedEventCount: 4,
    window: { fromSeq: 4, omittedEvents: 0, omittedRows: 0 },
    task: child.task ? { seq: 4, text: child.task, truncated: false } : null,
    rows: child.lastReply
      ? [
          {
            kind: 'assistant',
            seq: 5,
            turn: 0,
            step: 0,
            text: child.lastReply,
            truncated: false,
          },
        ]
      : [],
    stream: {
      mode: 'replace',
      cursor: 8,
      instanceId: `${childId}-instance`,
      revision: 0,
      complete: true,
      active: null,
    },
  };
}

type Source = {
  summary: (sessionId: string) => NativeSubagentSummary | null | 'error';
  snapshot?: typeof snapshotFor;
  status?: number;
};
type Connection = {
  fixture: string;
  sessionId: string;
  childId: string | null;
  liveOnly: boolean;
  response: ServerResponse;
};

/** Product WS gateway over a real held loopback SSE; no browser transport mock. */
export class NativeSubagentFixtureFeed {
  gateway?: ReturnType<typeof createNativeSubagentFollowGateway>;
  sources = new Map<string, Source>();
  connections = new Set<Connection>();
  rootConnections = new Set<{ fixture: string; response: ServerResponse }>();
  calls: Omit<Connection, 'response'>[] = [];
  attach(server: Server) {
    this.gateway = createNativeSubagentFollowGateway({
      port: (server.address() as { port: number }).port,
    });
    server.on('upgrade', (req, socket, head) => {
      void this.gateway!.upgrade(req, socket, head);
    });
  }
  async bindPage(page: Page, origin: string, fixture: string) {
    await page
      .context()
      .addCookies([
        { name: 'native-subagent-fixture', value: fixture, url: origin },
      ]);
  }
  async close() {
    await this.gateway?.close();
  }
  register(source: Source) {
    const id = String(this.sources.size + 1);
    this.sources.set(id, source);
    return id;
  }
  handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const fixture =
      url.searchParams.get('fixture') ??
      request.headers.cookie?.match(
        /(?:^|; )native-subagent-fixture=([^;]+)/,
      )?.[1];
    if (fixture && url.pathname.startsWith('/api/v1/runs/')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      const connection = { fixture, response };
      this.rootConnections.add(connection);
      response.on('close', () => this.rootConnections.delete(connection));
      return true;
    }
    if (!fixture || url.searchParams.get('follow') !== 'true') return false;
    const source = this.sources.get(fixture);
    const sessionId = url.pathname.split('/')[4]!;
    const childId = url.searchParams.get('childId');
    const liveOnly = url.searchParams.get('liveOnly') === 'true';
    this.calls.push({ fixture, sessionId, childId, liveOnly });
    const summary = source?.summary(sessionId);
    if (!source || source.status || !summary || summary === 'error') {
      response.writeHead(source?.status ?? 503).end();
      return true;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    const connection = { fixture, sessionId, childId, liveOnly, response };
    this.connections.add(connection);
    response.on('close', () => this.connections.delete(connection));
    this.send(connection, { type: 'directory', summary });
    if (childId)
      this.send(connection, {
        type: 'snapshot',
        snapshot: (source.snapshot ?? snapshotFor)(summary, childId),
      });
    return true;
  }
  send(connection: Connection, event: NativeSubagentFollowEvent) {
    connection.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  pushRoot(fixture: string, event: ChatFlowEventEnvelope) {
    for (const connection of this.rootConnections)
      if (connection.fixture === fixture)
        connection.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  push(
    fixture: string,
    event: NativeSubagentFollowEvent,
    childId: string | null = null,
    sessionId = 'parent-a',
  ) {
    for (const connection of this.connections)
      if (
        connection.fixture === fixture &&
        connection.sessionId === sessionId &&
        connection.childId === childId
      )
        this.send(connection, event);
  }
  end(fixture: string, childId: string | null, abrupt = false) {
    for (const connection of this.connections)
      if (connection.fixture === fixture && connection.childId === childId)
        if (abrupt) connection.response.destroy();
        else connection.response.end();
  }
}
