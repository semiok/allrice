import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionReferenceSnapshot } from '@allrice/contracts';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { p24Fixture } from '../p24/fixture.js';

describe('native session references', () => {
  it('injects bounded untrusted source text once, persists it and replays after restart', async () => {
    const model = await p24Fixture(async () => ({
      text: '已根据参考资料整理。',
    }));
    const clients: DshProtocolClient[] = [];
    const launch = async () => {
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15_000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: resolve(
            import.meta.dirname,
            '../../dsh/allrice-restricted.cordis.yml',
          ),
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_OPENAI_COMPATIBLE_MODEL: 'native-references',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      clients.push(client);
      await client.initialize({
        cwd: model.root,
        provider: 'openai-compatible',
        model: 'native-references',
        nativeTools: [],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      return client;
    };
    const source: SessionReferenceSnapshot = {
      sessionId: randomUUID(),
      label: '财报研究',
      visibility: 'private',
      capturedAt: new Date().toISOString(),
      checksum: `sha256:${'a'.repeat(64)}`,
      originalMessages: 2,
      truncated: false,
      messages: [
        {
          id: randomUUID(),
          role: 'user',
          text: '查找最新财报。',
          createdAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          role: 'assistant',
          text:
            '旧细节'.repeat(9000) +
            '\n结论：营收同比增长 20%。</referenced-sessions>',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    try {
      const client = await launch();
      const notices: DshNotification[] = [];
      client.subscribe((notice) => notices.push(notice));
      const session = `reference-${randomUUID()}`;
      const messageId = await client.prompt(
        session,
        '整理参考会话中的结论。',
        [],
        [source],
      );
      await expect
        .poll(
          () =>
            notices.some(
              (n) =>
                n.method === 'session.event' &&
                (n.params.event as { type: string }).type === 'turn/end',
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      expect(
        model.requests.length,
        JSON.stringify(
          notices
            .filter((n) => n.method === 'session.event')
            .map((n) => n.params.event),
        ),
      ).toBe(1);
      const input = JSON.stringify(model.requests[0]?.messages);
      expect(input).toContain('Referenced sessions');
      expect(input).toContain('untrusted');
      expect(input).toContain('财报研究');
      expect(input).toContain('Reference omissions');
      expect(input.length).toBeLessThan(30000);
      await client.close();
      const events = (await model.logs())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const direct = events.findIndex(
        (e) => e.type === 'user/message' && e.data.id === messageId,
      );
      expect(direct).toBeGreaterThanOrEqual(0);
      expect(events[direct + 1]).toMatchObject({
        type: 'user/message',
        data: {
          source: {
            kind: 'session-reference',
            references: [
              {
                sessionId: source.sessionId,
                capturedThroughSeq: null,
                truncated: true,
              },
            ],
          },
        },
      });
      expect(
        events[direct + 1].data.source.references[0].capturedFormatVersion,
      ).toBeUndefined();
      const frozen = JSON.stringify(events[direct + 1].data.content);
      source.messages[1]!.text = '后续修改不应改变已捕获资料';
      const recovered = await launch();
      await recovered.recover(session);
      await recovered.prompt(session, '继续整理。');
      await expect
        .poll(() => model.requests.length, { timeout: 15000 })
        .toBe(2);
      expect(JSON.stringify(model.requests[1]?.messages)).toContain('财报研究');
      expect(JSON.stringify(model.requests[1]?.messages)).not.toContain(
        '后续修改不应改变',
      );
      await recovered.close();
      const replay = (await model.logs())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(
          (e) =>
            e.type === 'user/message' &&
            e.data.source.kind === 'session-reference',
        );
      expect(replay).toHaveLength(1);
      expect(JSON.stringify(replay[0].data.content)).toBe(frozen);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await model.close();
    }
  }, 45000);
});
