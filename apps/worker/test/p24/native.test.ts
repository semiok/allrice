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
      const childRequests = () =>
        f.requests.filter((r) => JSON.stringify(r).includes('CHECK_APPROVAL'));
      await expect
        .poll(() => childRequests().length, { timeout: 15_000 })
        .toBe(2);
      expect(proposals[0]).toMatchObject({
        childId: child,
        parentId: root,
        nativeOutcome: 'rejected',
      });
      expect(JSON.stringify(childRequests())).not.toContain(
        'ROOT_PRIVATE_CONTEXT',
      );
      expect(JSON.stringify(childRequests()[1])).toContain('proposal_only');
      // A child's normal settlement separately wakes its parent. It is not a
      // second proposal or a child tool-result adoption.
      await expect
        .poll(async () => JSON.stringify((await c.snapshot(root)).events))
        .toContain('subagent-settled');
      await expect
        .poll(
          () =>
            f.requests.filter((r) =>
              JSON.stringify(r).includes('ROOT_PRIVATE_CONTEXT'),
            ).length,
        )
        .toBe(2);
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

  it('uses native adjacent-agent messages that wake the parent and cold-resumes the same child identity', async () => {
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
      await c.call('message', {
        id: child,
        targetId: root,
        text: 'SELECTED_REPORT',
      });
      await expect.poll(() => f.requests.length).toBe(2);
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
      const resumedRequest = () =>
        f.requests.find((r) => JSON.stringify(r).includes('COLD_FOLLOWUP'));
      await expect.poll(resumedRequest, { timeout: 15_000 }).toBeDefined();
      expect(JSON.stringify(resumedRequest())).toContain('HOLD_CHILD');
      await c.close();
      expect(await f.logs()).toContain('"kind":"agent-message"');
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
      // The unrelated tree must still settle and wake its own parent normally.
      // No model request may come from the drained root or its descendants.
      await expect
        .poll(
          () =>
            f.requests
              .slice(4)
              .filter((r) => JSON.stringify(r).includes(unrelated)).length,
        )
        .toBe(1);
      await c.call('idle', { id: other });
      expect(f.requests.slice(4)).toHaveLength(1);
      expect(JSON.stringify(f.requests.slice(4))).toContain(unrelated);
      for (const id of [child, grandchild, sibling])
        expect(JSON.stringify(f.requests.slice(4))).not.toContain(id);
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
      const childRequests = () =>
        f.requests.filter((r) =>
          JSON.stringify(r).includes('DURABLE_FIRST_PROMPT'),
        );
      await expect
        .poll(() => childRequests().length, { timeout: 15_000 })
        .toBe(3);
      expect(JSON.stringify(childRequests()[1])).toContain(
        'CHECKPOINTED_QUEUED_INPUT',
      );
      expect(JSON.stringify(childRequests()[1])).not.toContain(
        'EXPLICIT_RECOVERY_PROMPT',
      );
      expect(JSON.stringify(childRequests()[2])).toContain(
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
  it('recovers only the inbox records actually persisted before SIGKILL', async () => {
    const hold = gate();
    // rc.3 owns the batching deadline internally. Admission alone is not a
    // durability guarantee: after the kill, the persisted bytes decide replay.
    const f = await p24Fixture(async (_request, index) => {
      if (index === 2) await hold.promise;
      return { text: 'Synthetic completed.' };
    });
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
      await c.crash();
      const persisted = (await f.logs()).includes('UNFLUSHED_QUEUED_INPUT');
      hold.release();
      c = f.launch();
      await c.call('ready');
      await c.call('resume', { id: root });
      await c.call('followup', {
        parentId: root,
        id: child,
        text: 'Explicit recovery.',
      });
      const recovered = () =>
        f.requests.find((r) =>
          JSON.stringify(r).includes('Explicit recovery.'),
        );
      await expect.poll(recovered, { timeout: 15_000 }).toBeDefined();
      expect(JSON.stringify(recovered())).toContain('Persisted first prompt.');
      expect(
        JSON.stringify(recovered()).includes('UNFLUSHED_QUEUED_INPUT'),
      ).toBe(persisted);
      await c.close();
      const adopted = (await f.logs())
        .split('\n')
        .filter(
          (line) =>
            line.includes('"type":"user/message"') &&
            line.includes(String(accepted.messageId)),
        );
      expect(adopted).toHaveLength(persisted ? 1 : 0);
    } finally {
      hold.release();
      await f.close();
    }
  }, 45_000);
});
