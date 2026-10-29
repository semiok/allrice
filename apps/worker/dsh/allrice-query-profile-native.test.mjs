import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { host } from '../test/native-subagent/fixture.mjs';

it.each(['allrice-restricted', 'allrice-technical'])(
  '%s exposes exact query but no search or delegation on the actual Host',
  async (productionProfile) => {
    const h = await host({ productionProfile });
    // No additional query, provider, approval or tool plugins enter this Host.
    expect(await readFile(join(h.directory, 'profile.yml'), 'utf8')).toBe(
      await readFile(
        resolve(import.meta.dirname, `${productionProfile}.cordis.yml`),
        'utf8',
      ),
    );
    await h.prompt('请简短回复，然后让我查看本任务的子任务进度。');
    await h.wait();
    expect(h.calls).toHaveLength(1);
    await expect(
      h.server.handleRequest('session/subagent-summary', {
        sessionId: h.root.id,
      }),
    ).resolves.toMatchObject({
      rootId: h.root.id,
      root: { source: 'live' },
      descendants: [],
    });
    await expect(
      h.ctx.sessionQuery.searchSessions({ query: '本任务' }),
    ).rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' });
    await expect(
      h.ctx.sessionQuery.searchEvents({
        sessionId: h.root.id,
        query: '本任务',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_QUERY_SEARCH_DISABLED' });
    expect(h.ctx.subagents.list()).toEqual([]);
    const global = h.ctx.tools.schemas();
    const scoped = h.ctx.tools.schemas(h.root);
    const sent = h.calls[0].tools ?? [];
    for (const schema of [...global, ...scoped, ...sent])
      expect([
        'subagent',
        'subagent_fork',
        'send_message',
        'interrupt_agent',
        'list_agents',
      ]).not.toContain(schema.name);
    // A positive surface check distinguishes the two unchanged profiles and
    // proves the model-facing table was not replaced by an empty fake.
    expect(sent.some((schema) => schema.name === 'ask_user_question')).toBe(
      productionProfile === 'allrice-restricted',
    );
  },
);
