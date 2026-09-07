import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gate, p24Fixture } from './fixture.js';

describe('P24 pinned native DSH continuable delegation (test-only composition)', () => {
  it('uses real delegation, isolates parent history, forces child approval=never and routes a separate proposal', async () => {
    const proposals: Record<string, unknown>[] = [];
    const f = await p24Fixture(
      async (request) => {
        const last = request.messages.at(-1);
        return last?.role === 'user' &&
          JSON.stringify(last).includes('CHECK_APPROVAL')
          ? { tool: { marker: 'CHECK_APPROVAL' } }
          : { text: 'Synthetic completed.' };
      },
      async (proposal) => {
        proposals.push(proposal);
        return { status: 'proposal_only' };
      },
    );
    const c = f.launch();
    const root = randomUUID();
    const child = randomUUID();
    const other = randomUUID();
    try {
      await c.call('ready');
      await c.call('create', { id: root });
      await c.call('prompt', { id: root, text: 'ROOT_PRIVATE_CONTEXT' });
      await c.call('idle', { id: root });
      const accepted = await c.call('start', {
        parentId: root,
        id: child,
        text: 'CHECK_APPROVAL',
      });
      expect(accepted.childId).toBe(child);
      await expect.poll(() => proposals.length, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => f.requests.length, { timeout: 15_000 }).toBe(3);
      expect(proposals[0]).toMatchObject({
        childId: child,
        parentId: root,
        nativeOutcome: 'rejected',
      });
      expect(JSON.stringify(f.requests[1])).not.toContain(
        'ROOT_PRIVATE_CONTEXT',
      );
      expect(JSON.stringify(f.requests[2])).toContain('proposal_only');
      expect((await c.snapshot(root)).interactiveRequests).toBe(0);
      await expect(
        c.call('start', { parentId: root, id: child, text: 'duplicate' }),
      ).rejects.toThrow();
      await c.call('create', { id: other });
      await expect(
        c.call('followup', {
          parentId: other,
          id: child,
          text: 'foreign parent',
        }),
      ).rejects.toThrow();
      await c.close();
      const logs = await f.logs();
      expect(logs).toContain('"policy":"never"');
      expect(logs).toContain('"source":"delegation"');
      expect(logs).toContain('"outcome":"rejected"');
    } finally {
      await f.close();
    }
  }, 45_000);

  it('routes selected reports without silently waking the parent and cold-resumes a child on the same durable identity', async () => {
    const hold = gate();
    const f = await p24Fixture(async (request) => {
      if (JSON.stringify(request.messages.at(-1)).includes('HOLD_CHILD'))
        await hold.promise;
      return { text: 'Synthetic completed.' };
    });
    let c = f.launch();
    const root = randomUUID();
    const child = randomUUID();
    try {
      await c.call('ready');
      await c.call('create', { id: root });
      await c.call('start', { parentId: root, id: child, text: 'HOLD_CHILD' });
      await expect.poll(() => f.requests.length).toBe(1);
      await c.call('report', {
        id: child,
        text: 'SELECTED_REPORT',
        delivery: 'quiet',
      });
      expect((await c.snapshot(root)).status).toBe('idle');
      expect(f.requests).toHaveLength(1);
      await c.call('prompt', { id: root, text: 'Read the report.' });
      await c.call('idle', { id: root });
      expect(JSON.stringify(f.requests[1])).toContain('SELECTED_REPORT');
      hold.release();
      await c.close();
      c = f.launch();
      await c.call('ready');
      await c.call('resume', { id: root });
      const list = await c.call<{
        children: { id: string; mode: string; depth: number }[];
      }>('list', { id: root });
      expect(list.children).toContainEqual(
        expect.objectContaining({ id: child, mode: 'continuable', depth: 1 }),
      );
      expect((await c.snapshot(child)).live).toBe(false);
      await c.call('followup', {
        parentId: root,
        id: child,
        text: 'COLD_FOLLOWUP',
      });
      await expect
        .poll(() => JSON.stringify(f.requests.at(-1)), { timeout: 15_000 })
        .toContain('COLD_FOLLOWUP');
      expect(JSON.stringify(f.requests.at(-1))).toContain('HOLD_CHILD');
      await c.close();
      expect(await f.logs()).toContain('"kind":"subagent-report"');
    } finally {
      hold.release();
      await f.close();
    }
  }, 45_000);

  it('distinguishes single-turn interrupt from child-first tree drain, closes admission and does not wake on late replies', async () => {
    const hold = gate();
    const f = await p24Fixture(async () => {
      await hold.promise;
      return { text: 'LATE_REPLY' };
    });
    const c = f.launch();
    const root = randomUUID(),
      child = randomUUID(),
      grandchild = randomUUID(),
      sibling = randomUUID();
    const other = randomUUID(),
      unrelated = randomUUID();
    try {
      await c.call('ready');
      await c.call('create', { id: root });
      await c.call('create', { id: other });
      await c.call('start', { parentId: root, id: child, text: 'hold child' });
      await c.call('start', {
        parentId: child,
        id: grandchild,
        text: 'hold grandchild',
      });
      await c.call('start', {
        parentId: root,
        id: sibling,
        text: 'hold sibling',
      });
      await c.call('start', {
        parentId: other,
        id: unrelated,
        text: 'hold unrelated',
      });
      await expect.poll(() => f.requests.length, { timeout: 15_000 }).toBe(4);
      await expect(
        c.call('interrupt', { parentId: other, id: child }),
      ).rejects.toThrow();
      await c.call('interrupt', { parentId: root, id: child });
      await expect
        .poll(async () => (await c.snapshot(child)).status)
        .toBe('idle');
      expect((await c.snapshot(grandchild)).status).toBe('running');
      expect((await c.snapshot(unrelated)).status).toBe('running');
      const drain = c.call('drain', { id: root });
      const newChild = c.call('start', {
        parentId: root,
        id: randomUUID(),
        text: 'must reject during drain',
      });
      await expect(newChild).rejects.toThrow();
      await drain;
      expect((await c.snapshot(child)).live).toBe(false);
      expect((await c.snapshot(grandchild)).live).toBe(false);
      expect((await c.snapshot(sibling)).live).toBe(false);
      expect((await c.snapshot(unrelated)).status).toBe('running');
      const events = (await c.snapshot(root)).observations
        .filter((e) => e.event === 'end')
        .map((e) => e.id);
      expect(events.indexOf(grandchild)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(grandchild)).toBeLessThan(events.indexOf(child));
      await expect(
        c.call('followup', {
          parentId: root,
          id: child,
          text: 'late followup',
        }),
      ).rejects.toThrow();
      hold.release();
      await c.call('idle', { id: unrelated }).catch(async () => {
        // A naturally settled child may already have released its live handle.
        expect((await c.snapshot(unrelated)).live).toBe(false);
      });
      expect(f.requests).toHaveLength(4);
      expect((await c.snapshot(root)).status).toBe('idle');
      await c.close();
      expect(await f.logs()).not.toContain('late followup');
    } finally {
      hold.release();
      await f.close();
    }
  }, 45_000);

  it('recovers checkpointed inbox work after SIGKILL without treating admission as step adoption', async () => {
    const hold = gate();
    const f = await p24Fixture(async (_request, index) => {
      if (index === 2) await hold.promise;
      return { text: 'Synthetic recovery completed.' };
    });
    let c = f.launch();
    const root = randomUUID(),
      child = randomUUID();
    try {
      await c.call('ready');
      await c.call('create', { id: root });
      await c.call('prompt', {
        id: root,
        text: 'Persist the root before delegation.',
      });
      await c.call('idle', { id: root });
      await c.call('flush', { id: root });
      await c.call('start', {
        parentId: root,
        id: child,
        text: 'DURABLE_FIRST_PROMPT',
      });
      await expect.poll(() => f.requests.length).toBe(2);
      const accepted = await c.call('followup', {
        parentId: root,
        id: child,
        text: 'CHECKPOINTED_QUEUED_INPUT',
      });
      expect(typeof accepted.messageId).toBe('string');
      await c.call('flush', { id: child });
      expect(await f.logs()).toContain('CHECKPOINTED_QUEUED_INPUT');
      expect(
        JSON.stringify(
          (await c.snapshot(child)).events.filter(
            (e) => e.type === 'user/message',
          ),
        ),
      ).not.toContain('CHECKPOINTED_QUEUED_INPUT');
      await c.crash();
      hold.release();
      c = f.launch();
      await c.call('ready');
      await c.call('resume', { id: root });
      expect(f.requests).toHaveLength(2);
      await c.call('followup', {
        parentId: root,
        id: child,
        text: 'EXPLICIT_RECOVERY_PROMPT',
      });
      await expect.poll(() => f.requests.length, { timeout: 15_000 }).toBe(4);
      expect(JSON.stringify(f.requests[2])).toContain('DURABLE_FIRST_PROMPT');
      expect(JSON.stringify(f.requests[2])).toContain(
        'CHECKPOINTED_QUEUED_INPUT',
      );
      expect(JSON.stringify(f.requests[2])).not.toContain(
        'EXPLICIT_RECOVERY_PROMPT',
      );
      expect(JSON.stringify(f.requests[3])).toContain(
        'EXPLICIT_RECOVERY_PROMPT',
      );
      await c.close();
      const adopted = (await f.logs())
        .split('\n')
        .filter(
          (line) =>
            line.includes('"type":"user/message"') &&
            line.includes(String(accepted.messageId)),
        );
      expect(adopted).toHaveLength(1);
      expect(await f.logs()).toContain('"policy":"never"');
    } finally {
      hold.release();
      await f.close();
    }
  }, 45_000);
  it('loses uncheckpointed admission on SIGKILL rather than silently inventing an inbox replay', async () => {
    const hold = gate();
    // Native configuration, not a fake inbox: widen its batching window so the
    // acknowledgement→disk gap is deterministic, while checkpoints stay real.
    const f = await p24Fixture(
      async (_request, index) => {
        if (index === 2) await hold.promise;
        return { text: 'Synthetic completed.' };
      },
      undefined,
      60_000,
    );
    let c = f.launch();
    const root = randomUUID(),
      child = randomUUID();
    try {
      await c.call('ready');
      await c.call('create', { id: root });
      await c.call('prompt', { id: root, text: 'Persist root.' });
      await c.call('idle', { id: root });
      await c.call('flush', { id: root });
      await c.call('start', {
        parentId: root,
        id: child,
        text: 'Persisted first prompt.',
      });
      await expect.poll(() => f.requests.length).toBe(2);
      await c.call('flush', { id: child });
      const accepted = await c.call('followup', {
        parentId: root,
        id: child,
        text: 'UNFLUSHED_QUEUED_INPUT',
      });
      expect(typeof accepted.messageId).toBe('string');
      expect(await f.logs()).not.toContain('UNFLUSHED_QUEUED_INPUT');
      await c.crash();
      hold.release();
      c = f.launch();
      await c.call('ready');
      await c.call('resume', { id: root });
      await c.call('followup', {
        parentId: root,
        id: child,
        text: 'Explicit recovery.',
      });
      await expect.poll(() => f.requests.length, { timeout: 15_000 }).toBe(3);
      expect(JSON.stringify(f.requests[2])).not.toContain(
        'UNFLUSHED_QUEUED_INPUT',
      );
      await c.close();
      expect(await f.logs()).not.toContain(String(accepted.messageId));
    } finally {
      hold.release();
      await f.close();
    }
  }, 45_000);
});
