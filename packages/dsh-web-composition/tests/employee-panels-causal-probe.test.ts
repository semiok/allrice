import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import {
  causalJournal,
  observeCausalPage,
} from './employee-panels-causal-network';
import {
  assertCausalInvariant,
  assertToolFaviconOutcome,
} from './employee-panels-causal-proof';
import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';

function snapshot(): PanelsCausalSnapshot {
  const rect = { x: 20, y: 30, width: 100, height: 100 };
  const styles = {
    'corner-shape': 'round',
    '--dsw-corner-shape': 'round',
    color: 'rgb(1,2,3)',
  };
  return {
    root: { ...rect },
    nodes: [
      {
        tag: 'SECTION',
        className: 'synthetic',
        text: 'synthetic',
        rect: { ...rect },
        styles: { ...styles },
        before: { ...styles },
        after: { ...styles },
        hovered: false,
        focused: false,
        bbox: null,
        matrix: null,
        animations: [],
      },
    ],
    ancestors: [],
    unclipped: true,
    hits: [true],
    active: 'BODY',
    pointerOutside: true,
  };
}
describe('causal experiment validity (pure data, no browser/Host)', () => {
  it('allows only the planned rigid translation', () => {
    const before = snapshot(),
      after = snapshot();
    after.root.x += 17;
    after.root.y -= 9;
    after.nodes[0]!.rect.x += 17;
    after.nodes[0]!.rect.y -= 9;
    expect(() =>
      assertCausalInvariant(before, after, { x: 17, y: -9 }),
    ).not.toThrow();
    expect(() => assertCausalInvariant(before, after)).toThrow('root geometry');
  });
  it('rejects a real 0.25px deformation rather than spending the 0.5px acceptance budget', () => {
    const a = snapshot(),
      b = snapshot();
    b.nodes[0]!.rect.width += 0.25;
    expect(() => assertCausalInvariant(a, b)).toThrow('deformed');
  });
  it('rejects clipping/occlusion', () => {
    const b = snapshot();
    b.unclipped = false;
    expect(() => assertCausalInvariant(snapshot(), b)).toThrow('clipped');
  });
  it('rejects focus or content replacement', () => {
    const b = snapshot();
    b.nodes[0]!.text = 'replaced';
    expect(() => assertCausalInvariant(snapshot(), b)).toThrow('identity');
  });
  it('permits a hover-only control but rejects its unplanned paint change', () => {
    const b = snapshot();
    b.nodes[0]!.hovered = true;
    expect(() =>
      assertCausalInvariant(snapshot(), b, { hover: true }),
    ).not.toThrow();
    b.nodes[0]!.styles.color = 'red';
    expect(() => assertCausalInvariant(snapshot(), b, { hover: true })).toThrow(
      'color',
    );
  });
  it('permits token invalidation only while actual corners and all other paint remain identical', () => {
    const b = snapshot();
    for (const part of ['styles', 'before', 'after'] as const)
      b.nodes[0]![part]['--dsw-corner-shape'] = '';
    expect(() =>
      assertCausalInvariant(snapshot(), b, { corner: true }),
    ).not.toThrow();
    b.nodes[0]!.styles['corner-shape'] = 'superellipse(1.5)';
    expect(() =>
      assertCausalInvariant(snapshot(), b, { corner: true }),
    ).toThrow();
  });
  it('rejects an active animation instead of accepting an unstable restoration', () => {
    const b = snapshot();
    b.nodes[0]!.animations.push({ state: 'running', time: 3 });
    expect(() => assertCausalInvariant(snapshot(), b)).toThrow('animation');
  });
  it('uses exact intrinsic SVG shape and CTM, with no new bounds epsilon', () => {
    const a = snapshot(),
      b = snapshot();
    for (const value of [a, b])
      Object.assign(value.nodes[0]!, {
        tag: 'path',
        bbox: { x: 1, y: 2, width: 6, height: 6 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 },
      });
    b.nodes[0]!.rect.width += 0.0001220703125;
    expect(() => assertCausalInvariant(a, b)).not.toThrow();
    b.nodes[0]!.bbox!.width += 0.01;
    expect(() => assertCausalInvariant(a, b)).toThrow('SVG shape');
  });
});

describe('tool-only route experiment outcomes; never an audit exemption', () => {
  const off = {
    mode: 'OFF' as const,
    starts: 1,
    method: 'GET',
    status: 200,
    finished: true,
    routeEntries: 0,
    serverHits: 1,
    unknownErrors: 0,
  };
  const on = {
    mode: 'ON' as const,
    starts: 1,
    method: 'GET',
    failure: 'net::ERR_ABORTED',
    canceled: true,
    routeEntries: 0,
    serverHits: 0,
    unknownErrors: 0,
  };
  it('accepts only a real completed OFF response and an exact pre-route ON cancellation', () => {
    expect(() => assertToolFaviconOutcome(off)).not.toThrow();
    expect(() => assertToolFaviconOutcome(on)).not.toThrow();
  });
  it.each([
    { ...on, starts: 2 },
    { ...on, method: 'POST' },
    { ...on, failure: 'net::ERR_FAILED' },
    { ...on, canceled: false },
    { ...on, status: 403 },
    { ...on, routeEntries: 1 },
    { ...on, serverHits: 1 },
    { ...on, unknownErrors: 1 },
    { ...off, finished: false },
    { ...off, status: 403 },
    { ...off, serverHits: 0 },
  ])('rejects ambiguous/unknown outcomes %#', (value) => {
    expect(() => assertToolFaviconOutcome(value)).toThrow();
  });
});

describe('passive public event ownership (synthetic CDP doubles only)', () => {
  const fake = () => {
    const session = Object.assign(new EventEmitter(), {
      send: vi.fn(async () => ({})),
      detach: vi.fn(async (): Promise<void> => {
        session.emit('close');
      }),
    });
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
    });
    return { session, page, publicPage: page as unknown as Page };
  };
  it('clears its event deadline and rejects when its own CDP session closes', async () => {
    vi.useFakeTimers();
    try {
      const value = fake(),
        trace = await observeCausalPage(
          value.publicPage,
          'synthetic',
          causalJournal(),
        );
      const waiting = expect(
        trace.terminal('http://synthetic.invalid/favicon.ico'),
      ).rejects.toThrow('CDP closed');
      await trace.close();
      await waiting;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('retains a non-fixture403 and JavaScript error without an exception or clearing raw events', async () => {
    const value = fake(),
      journal = causalJournal(),
      trace = await observeCausalPage(value.publicPage, 'synthetic', journal);
    expect(() => trace.assertClean()).not.toThrow();
    value.session.emit('Network.requestWillBeSent', {
      requestId: 'one',
      request: { url: 'http://nonfixture.invalid/denied', method: 'GET' },
    });
    value.session.emit('Network.responseReceived', {
      requestId: 'one',
      response: { status: 403 },
    });
    value.page.emit(
      'pageerror',
      new TypeError('same-URL JavaScript exception'),
    );
    expect(trace.errors).toHaveLength(2);
    expect(() => trace.assertClean()).toThrow('Unclassified');
    expect(journal.events.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    await trace.close();
    expect(journal.events).toHaveLength(4);
    expect(trace.errors).toHaveLength(2);
  });
  it.each([
    { errorText: 'net::ERR_FAILED', canceled: false },
    { errorText: 'net::ERR_ABORTED', canceled: true },
    { errorText: 'net::ERR_CONNECTION_RESET', canceled: false },
  ])('invalidates A for a matched CDP-only failure %#', async (failure) => {
    const value = fake(),
      journal = causalJournal(),
      trace = await observeCausalPage(value.publicPage, 'A', journal);
    value.session.emit('Network.requestWillBeSent', {
      requestId: 'matched',
      request: { url: 'http://synthetic.invalid/favicon.ico', method: 'GET' },
    });
    const raw = { requestId: 'matched', ...failure };
    value.session.emit('Network.loadingFailed', raw);
    expect(trace.errors).toEqual([]); // No Page/log/console counterpart.
    expect(trace.cdpFailures).toEqual([raw]);
    expect(() => trace.assertClean()).toThrow('Unclassified');
    expect(journal.events.map((entry) => entry.name)).toEqual([
      'Network.requestWillBeSent',
      'Network.loadingFailed',
    ]);
    await trace.close();
    expect(trace.cdpFailures).toEqual([raw]);
  });
  it('retains and rejects an additional same-URL request failure without promoting B into an exemption', async () => {
    const value = fake(),
      trace = await observeCausalPage(value.publicPage, 'A', causalJournal());
    for (const requestId of ['one', 'extra']) {
      value.session.emit('Network.requestWillBeSent', {
        requestId,
        request: { url: 'http://synthetic.invalid/favicon.ico', method: 'GET' },
      });
      value.session.emit('Network.loadingFailed', {
        requestId,
        errorText: 'net::ERR_ABORTED',
        canceled: true,
      });
    }
    expect(trace.cdpFailures).toHaveLength(2);
    expect(trace.errors).toEqual([]);
    expect(() => trace.assertClean()).toThrow('Unclassified');
    await trace.close();
  });
});
