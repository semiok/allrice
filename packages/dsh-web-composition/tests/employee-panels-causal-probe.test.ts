import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import {
  causalJournal,
  causalReplayOrigin,
  auditCausalToolControl,
  observeCausalPage,
} from './employee-panels-causal-network';
import {
  assertCausalInvariant,
  assertCausalSampling,
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
  const content = {
    identity: 1,
    parentIdentity: null,
    svgGeometry: false,
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
  };
  const hits = [
    [21, 31],
    [119, 31],
    [21, 129],
    [119, 129],
    [70, 80],
  ].map(([x, y]) => ({
    x: x!,
    y: y!,
    rootContains: true,
    element: { ...content, attributes: {} as Record<string, string> },
  }));
  return {
    root: { ...rect },
    nodes: [content],
    ancestors: [],
    unclipped: true,
    hits: hits.map(() => true),
    sampling: {
      clipBudgetVisible: true,
      raw: hits,
      resize: null,
      interior: { ...rect },
      interiorHits: structuredClone(hits),
      subjects: [
        {
          identity: 1,
          rect: { ...rect },
          coordinateSpace: 'border-box',
          hits: hits.map((hit) => ({
            ...structuredClone(hit),
            local: { x: hit.x - rect.x, y: hit.y - rect.y },
            relation: 'self',
            blank: null,
          })),
        },
      ],
    },
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
    after.sampling.interior.x += 17;
    after.sampling.interior.y -= 9;
    after.sampling.subjects[0]!.rect.x += 17;
    after.sampling.subjects[0]!.rect.y -= 9;
    for (const hit of [
      ...after.sampling.raw,
      ...after.sampling.interiorHits,
      ...after.sampling.subjects.flatMap((subject) => subject.hits),
    ]) {
      hit.x += 17;
      hit.y -= 9;
    }
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
    b.sampling.clipBudgetVisible = false;
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
      value.nodes.push({
        ...structuredClone(value.nodes[0]!),
        identity: 2,
        parentIdentity: 1,
        tag: 'path',
        svgGeometry: true,
        bbox: { x: 1, y: 2, width: 6, height: 6 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 },
      });
    b.nodes[1]!.rect.width += 0.0001220703125;
    expect(() => assertCausalInvariant(a, b)).not.toThrow();
    b.nodes[1]!.bbox!.width += 0.01;
    expect(() => assertCausalInvariant(a, b)).toThrow('SVG shape');
  });
});

function resizeSnapshot(): PanelsCausalSnapshot {
  const value = snapshot();
  const control = {
    ...structuredClone(value.nodes[0]!),
    identity: 99,
    tag: 'DIV',
    attributes: { 'data-side': 'rightbar' } as Record<string, string>,
    rect: { x: 15, y: 20, width: 8, height: 120 },
    styles: {
      position: 'absolute',
      cursor: 'col-resize',
      'pointer-events': 'auto',
      'z-index': '11',
      visibility: 'visible',
      opacity: '1',
      'background-color': 'rgba(0, 0, 0, 0)',
      'background-image': 'none',
      'border-width': '0px',
      'border-image-source': 'none',
      'box-shadow': 'none',
      'outline-style': 'none',
      filter: 'none',
      'backdrop-filter': 'none',
      'mask-image': 'none',
      'clip-path': 'none',
    },
    before: { content: 'none' },
    after: { content: 'none' },
  };
  value.sampling.resize = {
    count: 1,
    rightbar: { x: 19, y: 20, width: 101, height: 120 },
    rightbarIdentity: 98,
    control,
    empty: true,
  };
  for (const index of [0, 2])
    value.sampling.raw[index] = {
      ...value.sampling.raw[index]!,
      rootContains: false,
      element: { ...control, attributes: { 'data-side': 'rightbar' } },
    };
  value.hits = value.sampling.raw.map((hit) => hit.rootContains);
  value.unclipped = false;
  value.sampling.interior = { x: 23, y: 30, width: 97, height: 100 };
  value.sampling.interiorHits[0]!.x = value.sampling.interiorHits[2]!.x = 24;
  value.sampling.subjects = [
    {
      identity: 2,
      rect: { x: 40, y: 50, width: 16, height: 16 },
      coordinateSpace: 'border-box',
      hits: [
        [1, 1],
        [15, 1],
        [1, 15],
        [15, 15],
        [8, 8],
      ].map(([x, y]) => ({
        ...structuredClone(value.sampling.interiorHits[0]!),
        x: 40 + x!,
        y: 50 + y!,
        local: { x: x!, y: y! },
        relation: 'self',
        blank: null,
        element: {
          ...structuredClone(value.nodes[0]!),
          identity: 2,
          parentIdentity: 1,
          rect: { x: 40, y: 50, width: 16, height: 16 },
          attributes: {},
        },
      })),
    },
  ];
  value.nodes.push({
    ...structuredClone(value.nodes[0]!),
    identity: 2,
    parentIdentity: 1,
    rect: { ...value.sampling.subjects[0]!.rect },
  });
  return value;
}

describe('specific subject hit ownership, not whole-section membership', () => {
  function withSibling() {
    const value = resizeSnapshot();
    value.nodes.push({
      ...structuredClone(value.nodes[1]!),
      identity: 3,
      parentIdentity: 1,
      styles: {
        ...value.nodes[1]!.styles,
        'background-color': 'rgb(255, 0, 0)',
      },
    });
    return value;
  }
  it.each([
    ['corner', 0],
    ['center', 4],
  ] as const)(
    'rejects an opaque same-section sibling at the %s sample',
    (_name, index) => {
      const value = withSibling();
      const hit = value.sampling.subjects[0]!.hits[index]!;
      hit.element = { ...structuredClone(value.nodes[2]!), attributes: {} };
      hit.relation = 'unrelated';
      expect(hit.rootContains).toBe(true);
      expect(() => assertCausalSampling(value)).toThrow('subject hit');
    },
  );
  it('rejects a forged self label for an unrelated recorded sibling', () => {
    const value = withSibling();
    value.sampling.subjects[0]!.hits[4]!.element = {
      ...structuredClone(value.nodes[2]!),
      attributes: {},
    };
    expect(() => assertCausalSampling(value)).toThrow('subject hit');
  });
  it('rejects an ancestor without explicit blank evidence', () => {
    const value = resizeSnapshot(),
      hit = value.sampling.subjects[0]!.hits[0]!;
    hit.element = { ...structuredClone(value.nodes[0]!), attributes: {} };
    hit.relation = 'ancestor';
    expect(() => assertCausalSampling(value)).toThrow('subject hit');
  });
  it('rejects a changed sample location even while both hits remain in the section', () => {
    const before = resizeSnapshot(),
      after = resizeSnapshot();
    after.sampling.subjects[0]!.hits[0]!.x += 0.25;
    after.sampling.subjects[0]!.hits[0]!.local.x += 0.25;
    expect(() => assertCausalInvariant(before, after)).toThrow('sample point');
  });
  it('rejects switching from self to a descendant between phases', () => {
    const before = resizeSnapshot(),
      after = resizeSnapshot();
    for (const value of [before, after])
      value.nodes.push({
        ...structuredClone(value.nodes[1]!),
        identity: 3,
        parentIdentity: 2,
      });
    const hit = after.sampling.subjects[0]!.hits[4]!;
    hit.element = { ...structuredClone(after.nodes[2]!), attributes: {} };
    hit.relation = 'descendant';
    expect(() => assertCausalInvariant(before, after)).toThrow('subject hit');
  });
  const paint = {
    transform: 'none',
    rotate: 'none',
    scale: 'none',
    zoom: '1',
    filter: 'none',
    'backdrop-filter': 'none',
    'box-shadow': 'none',
    'mask-image': 'none',
    'clip-path': 'none',
    'border-image-source': 'none',
    'outline-style': 'none',
    'background-color': 'rgba(0, 0, 0, 0)',
    'background-image': 'none',
    'border-width': '0px',
    opacity: '1',
    fill: 'none',
    stroke: 'black',
    'border-top-left-radius': '8px',
    'border-top-right-radius': '8px',
    'border-bottom-right-radius': '8px',
    'border-bottom-left-radius': '8px',
  };
  function blankSnapshot(kind: 'svg' | 'round') {
    const value = resizeSnapshot();
    for (const node of value.nodes) {
      Object.assign(node.styles, paint);
      node.before.content = node.after.content = 'none';
    }
    const subject = value.sampling.subjects[0]!,
      node = value.nodes[1]!;
    const hit = subject.hits[0]!;
    hit.relation = 'ancestor';
    if (kind === 'svg') {
      Object.assign(node, {
        tag: 'path',
        svgGeometry: true,
        parentIdentity: 3,
        bbox: { x: 0, y: 0, width: 16, height: 16 },
        matrix: { a: 1, b: 0, c: 0, d: 1, e: 40, f: 50 },
      });
      value.nodes.push({
        ...structuredClone(node),
        identity: 3,
        parentIdentity: 1,
        tag: 'svg',
        svgGeometry: false,
      });
      subject.coordinateSpace = 'svg';
      hit.element = { ...structuredClone(value.nodes[2]!), attributes: {} };
      hit.blank = {
        kind: 'svg-blank',
        geometries: [
          { identity: 2, local: { x: 1, y: 1 }, fill: false, stroke: false },
        ],
      };
    } else {
      hit.element = { ...structuredClone(value.nodes[0]!), attributes: {} };
      hit.blank = { kind: 'round-cutout', textRects: [], geometries: [] };
    }
    return value;
  }
  it('allows only explicit SVG blank geometry for an actual ancestor hit', () => {
    const value = blankSnapshot('svg');
    expect(() => assertCausalSampling(value)).not.toThrow();
    value.sampling.subjects[0]!.hits[0]!.blank!.geometries[0]!.stroke = true;
    expect(() => assertCausalSampling(value)).toThrow('not proved SVG blank');
  });
  it('allows fill-none geometry only while the sampled point has no stroke paint', () => {
    const value = blankSnapshot('svg');
    value.sampling.subjects[0]!.hits[0]!.blank!.geometries[0]!.fill = true;
    expect(() => assertCausalSampling(value)).not.toThrow();
    value.nodes[1]!.styles.fill = 'black';
    expect(() => assertCausalSampling(value)).toThrow('not proved SVG blank');
  });
  it('rejects SVG background paint even when fill and stroke tests are blank', () => {
    const value = blankSnapshot('svg');
    value.nodes[1]!.styles['background-color'] = 'rgb(255, 0, 0)';
    expect(() => assertCausalSampling(value)).toThrow('not proved SVG blank');
  });
  it.each(['missing', 'duplicate', 'foreign'] as const)(
    'rejects %s SVG geometry evidence',
    (kind) => {
      const value = blankSnapshot('svg'),
        tests = value.sampling.subjects[0]!.hits[0]!.blank!.geometries;
      if (kind === 'missing') tests.length = 0;
      if (kind === 'duplicate') tests.push(structuredClone(tests[0]!));
      if (kind === 'foreign') tests[0]!.identity = 1;
      expect(() => assertCausalSampling(value)).toThrow('SVG blank');
    },
  );
  it('allows an empty standard round cutout but rejects its painted center', () => {
    const value = blankSnapshot('round');
    expect(() => assertCausalSampling(value)).not.toThrow();
    const center = value.sampling.subjects[0]!.hits[4]!;
    center.element = structuredClone(
      value.sampling.subjects[0]!.hits[0]!.element,
    );
    center.relation = 'ancestor';
    center.blank = structuredClone(value.sampling.subjects[0]!.hits[0]!.blank);
    expect(() => assertCausalSampling(value)).toThrow('clear round cutout');
  });
  it('rejects text paint inside a purported round cutout', () => {
    const value = blankSnapshot('round'),
      blank = value.sampling.subjects[0]!.hits[0]!.blank!;
    if (blank.kind !== 'round-cutout')
      throw Error('synthetic fixture mismatch');
    blank.textRects.push({ x: 40, y: 50, width: 2, height: 2 });
    expect(() => assertCausalSampling(value)).toThrow('clear round cutout');
  });
  it('rejects unproved round geometry after scale or corner-shape changes', () => {
    const value = blankSnapshot('round');
    value.nodes[1]!.styles.transform = 'matrix(2, 0, 0, 2, 0, 0)';
    expect(() => assertCausalSampling(value)).toThrow('unscaled translation');
    value.nodes[1]!.styles.transform = 'none';
    value.nodes[1]!.styles['corner-shape'] = 'superellipse(1.5)';
    expect(() => assertCausalSampling(value)).toThrow('standard round cutout');
  });
  it('normalizes SVG samples by exact intrinsic frame and CTM, without a bounds epsilon', () => {
    const before = blankSnapshot('svg'),
      after = blankSnapshot('svg');
    after.nodes[1]!.rect.width += 0.0001220703125;
    after.sampling.subjects[0]!.rect.width += 0.0001220703125;
    expect(() => assertCausalInvariant(before, after)).not.toThrow();
    const hit = after.sampling.subjects[0]!.hits[0]!;
    hit.element = { ...structuredClone(after.nodes[1]!), attributes: {} };
    hit.relation = 'self';
    hit.blank = null;
    expect(() => assertCausalInvariant(before, after)).toThrow('subject hit');
  });
  it('checks SVG local sample points under the planned rigid translation', () => {
    const before = blankSnapshot('svg'),
      after = blankSnapshot('svg');
    for (const rect of [
      after.root,
      after.sampling.interior,
      ...after.nodes.map((node) => node.rect),
      ...after.sampling.subjects.map((subject) => subject.rect),
      after.sampling.resize!.rightbar,
      after.sampling.resize!.control.rect,
    ]) {
      rect.x += 17;
      rect.y -= 9;
    }
    for (const node of after.nodes)
      if (node.matrix) {
        node.matrix.e += 17;
        node.matrix.f -= 9;
      }
    for (const hit of [
      ...after.sampling.raw,
      ...after.sampling.interiorHits,
      ...after.sampling.subjects.flatMap((subject) => subject.hits),
    ]) {
      hit.x += 17;
      hit.y -= 9;
    }
    expect(() =>
      assertCausalInvariant(before, after, { x: 17, y: -9 }),
    ).not.toThrow();
    after.sampling.subjects[0]!.hits[0]!.local.x += 0.25;
    expect(() =>
      assertCausalInvariant(before, after, { x: 17, y: -9 }),
    ).toThrow('sample point');
  });
});
describe('scoped paint sampling preserves the failed full-root verdict', () => {
  it('requires direct native-control identity and leaves both raw misses false', () => {
    const value = resizeSnapshot();
    expect(() => assertCausalSampling(value)).not.toThrow();
    expect(value.unclipped).toBe(false);
    expect(value.hits).toEqual([false, true, false, true, true]);
    expect(() => assertCausalInvariant(value, resizeSnapshot())).not.toThrow();
  });
  it.each([
    [
      'relabelled full-root result',
      (v: PanelsCausalSnapshot) => {
        v.unclipped = true;
      },
    ],
    [
      'foreign hit identity',
      (v: PanelsCausalSnapshot) => {
        v.sampling.raw[0]!.element!.identity = 88;
      },
    ],
    [
      'missing native attribute',
      (v: PanelsCausalSnapshot) => {
        v.sampling.raw[0]!.element!.attributes = {};
      },
    ],
    [
      'interior occluder',
      (v: PanelsCausalSnapshot) => {
        v.sampling.interiorHits[0]!.rootContains = false;
      },
    ],
    [
      'missing hit identity',
      (v: PanelsCausalSnapshot) => {
        v.sampling.interiorHits[0]!.element = null;
      },
    ],
    [
      'opaque control',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.control.styles['background-color'] = 'rgb(1, 2, 3)';
      },
    ],
    [
      'painted control pseudo',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.control.before.content = '"x"';
      },
    ],
    [
      'duplicate control',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.count = 2;
      },
    ],
    [
      'changed native width',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.control.rect.width = 9;
      },
    ],
    [
      'short control',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.control.rect.height = 100;
      },
    ],
    [
      'arbitrary exclusion',
      (v: PanelsCausalSnapshot) => {
        v.sampling.interior.x++;
      },
    ],
    [
      'curve in unproved strip',
      (v: PanelsCausalSnapshot) => {
        v.sampling.subjects[0]!.rect.x = 21;
      },
    ],
    [
      'covered curve',
      (v: PanelsCausalSnapshot) => {
        v.sampling.subjects[0]!.hits[0]!.rootContains = false;
      },
    ],
    [
      'clip budget failure',
      (v: PanelsCausalSnapshot) => {
        v.sampling.clipBudgetVisible = false;
      },
    ],
    [
      'missing paint subjects',
      (v: PanelsCausalSnapshot) => {
        v.sampling.subjects = [];
      },
    ],
    [
      'active native drag',
      (v: PanelsCausalSnapshot) => {
        v.sampling.resize!.control.attributes['data-dragging'] = 'true';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const value = resizeSnapshot();
    mutate(value);
    expect(() => assertCausalSampling(value)).toThrow(
      'Invalid causal sampling',
    );
  });
  it('still rejects foreign occlusion when no native-control exclusion is registered', () => {
    const value = snapshot();
    value.sampling.raw[0]!.rootContains = false;
    value.hits[0] = false;
    value.unclipped = false;
    expect(() => assertCausalSampling(value)).toThrow('unrecognized');
  });
  it('rejects replacement of a valid native control between phases', () => {
    const a = resizeSnapshot(),
      b = resizeSnapshot();
    b.sampling.resize!.control.identity = 100;
    for (const hit of b.sampling.raw)
      if (!hit.rootContains) hit.element!.identity = 100;
    expect(() => assertCausalInvariant(a, b)).toThrow(
      'resize control identity',
    );
  });
  it('rejects a changed rightbar scope even when the handle is unchanged', () => {
    const a = resizeSnapshot(),
      b = resizeSnapshot();
    b.sampling.resize!.rightbarIdentity = 101;
    expect(() => assertCausalInvariant(a, b)).toThrow(
      'resize control identity',
    );
  });
});

function replayEvents() {
  const journal = causalJournal(),
    record = (name: string, data: unknown) =>
      journal.record('reference', name, data);
  const registration = {
    id: 'owned-replay',
    origin: causalReplayOrigin,
    navigationUrl: causalReplayOrigin + '/?kind=experience',
    method: 'GET',
    bodySha256: 'a'.repeat(64),
  };
  const receipt = { ...registration, url: registration.navigationUrl };
  record('replay-registration', registration);
  record('Network.requestWillBeSent', {
    requestId: 'document',
    loaderId: 'document',
    frameId: 'main',
    documentURL: registration.navigationUrl,
    type: 'Document',
    request: { url: registration.navigationUrl, method: 'GET' },
  });
  record('route-entry', receipt);
  record('route-fulfill-issued', { ...receipt, status: 200 });
  record('Network.responseReceived', {
    requestId: 'document',
    loaderId: 'document',
    frameId: 'main',
    type: 'Document',
    response: {
      url: registration.navigationUrl,
      status: 200,
      headers: { 'x-allrice-causal-replay': registration.id },
    },
  });
  record('Network.loadingFinished', { requestId: 'document' });
  record('route-fulfilled', { ...receipt, status: 200 });
  record('replay-navigation-complete', {
    ...receipt,
    status: 200,
    mainFrame: true,
  });
  record('Network.requestWillBeSent', {
    requestId: 'icon',
    loaderId: 'document',
    frameId: 'main',
    documentURL: registration.navigationUrl,
    type: 'Other',
    request: {
      url: causalReplayOrigin + '/favicon.ico',
      method: 'GET',
      headers: { Referer: registration.navigationUrl },
    },
    initiator: { type: 'other' },
    timestamp: 2,
  });
  record('Network.loadingFailed', {
    requestId: 'icon',
    type: 'Other',
    errorText: 'net::ERR_ABORTED',
    canceled: true,
    timestamp: 3,
  });
  return journal.events;
}
describe('diagnostic-only trusted replay classification; raw outcomes remain', () => {
  it('classifies exactly one raw CDP-only failure by the complete owned navigation chain', () => {
    const events = replayEvents(),
      audit = auditCausalToolControl(events, 'reference');
    expect(audit.issues).toEqual([]);
    expect(audit.controlledFailures).toEqual([events[9]!.data]);
    expect(audit.controlledFailures[0]).toBe(events[9]!.data);
    expect(events).toHaveLength(10);
    expect(auditCausalToolControl(events, 'native').controlledFailures).toEqual(
      [],
    );
  });
  it.each([
    [
      'untrusted origin',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[0]!.data!, { origin: 'http://elsewhere.invalid' });
      },
    ],
    [
      'wrong navigation',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[0]!.data!, {
          navigationUrl: causalReplayOrigin + '/?other',
        });
      },
    ],
    [
      'POST icon',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign((e[8]!.data as { request: object }).request, {
          method: 'POST',
        });
      },
    ],
    [
      'different loader',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[8]!.data!, { loaderId: 'another' });
      },
    ],
    [
      'different frame',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[8]!.data!, { frameId: 'child' });
      },
    ],
    [
      'different initiator',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[8]!.data!, { initiator: { type: 'script' } });
      },
    ],
    [
      'different referrer',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign((e[8]!.data as { request: object }).request, {
          headers: { Referer: 'http://elsewhere.invalid/' },
        });
      },
    ],
    [
      'wrong abort',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[9]!.data!, { errorText: 'net::ERR_FAILED' });
      },
    ],
    [
      'not cancelled',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[9]!.data!, { canceled: false });
      },
    ],
    [
      'blocked reason',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[9]!.data!, { blockedReason: 'other' });
      },
    ],
    [
      '403 document',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign((e[4]!.data as { response: object }).response, {
          status: 403,
        });
      },
    ],
    [
      'missing response payload',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[4]!.data!, { response: undefined });
      },
    ],
    [
      'foreign response token',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign((e[4]!.data as { response: object }).response, {
          headers: { 'x-allrice-causal-replay': 'foreign' },
        });
      },
    ],
    [
      'body mismatch receipt',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[6]!.data!, { bodySha256: 'b'.repeat(64) });
      },
    ],
    [
      'subframe navigation',
      (e: ReturnType<typeof replayEvents>) => {
        Object.assign(e[7]!.data!, { mainFrame: false });
      },
    ],
    [
      'missing completion',
      (e: ReturnType<typeof replayEvents>) => {
        e.splice(6, 1);
      },
    ],
    [
      'same-URL concurrent request',
      (e: ReturnType<typeof replayEvents>) => {
        e.splice(9, 0, structuredClone(e[8]!));
      },
    ],
    [
      'extra response',
      (e: ReturnType<typeof replayEvents>) => {
        e.push({
          seq: 10,
          receivedAt: 10,
          side: 'reference',
          name: 'Network.responseReceived',
          data: { requestId: 'icon', response: { status: 403 } },
        });
      },
    ],
    [
      'public favicon counterpart',
      (e: ReturnType<typeof replayEvents>) => {
        e.push({
          seq: 10,
          receivedAt: 10,
          side: 'reference',
          name: 'Page.requestfailed',
          data: { url: causalReplayOrigin + '/favicon.ico' },
        });
      },
    ],
    [
      'reordered terminal',
      (e: ReturnType<typeof replayEvents>) => {
        e.splice(4, 0, e.pop()!);
      },
    ],
    [
      'missing registration',
      (e: ReturnType<typeof replayEvents>) => {
        e.shift();
      },
    ],
  ])('keeps %s unclassified', (_label, mutate) => {
    const events = replayEvents();
    mutate(events);
    events.forEach((event, index) => {
      event.seq = index;
    });
    expect(
      auditCausalToolControl(events, 'reference').controlledFailures,
    ).toEqual([]);
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
  const emitReplay = (
    value: ReturnType<typeof fake>,
    journal: ReturnType<typeof causalJournal>,
  ) => {
    for (const event of replayEvents()) {
      if (event.name.startsWith('Network.'))
        value.session.emit(event.name, event.data);
      else journal.record('reference', event.name, event.data);
    }
  };
  it('keeps the classified raw failure and receipts while allowing only the registered diagnostic chain', async () => {
    const value = fake(),
      journal = causalJournal(),
      trace = await observeCausalPage(value.publicPage, 'reference', journal);
    emitReplay(value, journal);
    expect(trace.cdpFailures).toHaveLength(1);
    expect(trace.audit().controlledFailures[0]).toBe(trace.cdpFailures[0]);
    expect(trace.audit().unknownCdpFailures).toEqual([]);
    expect(() => trace.assertClean()).not.toThrow();
    await trace.close();
    expect(trace.cdpFailures).toHaveLength(1);
    expect(
      journal.events.some((event) => event.name === 'Network.loadingFailed'),
    ).toBe(true);
  });
  it.each([
    'pageerror',
    'console-error',
    'network-log-error',
    'nonfixture403',
    'unplanned-abort',
  ])('still blocks %s beside the trusted diagnostic chain', async (kind) => {
    const value = fake(),
      journal = causalJournal(),
      trace = await observeCausalPage(value.publicPage, 'reference', journal);
    emitReplay(value, journal);
    if (kind === 'pageerror')
      value.page.emit(
        'pageerror',
        new Error(
          causalReplayOrigin +
            '/favicon.ico net::ERR_ABORTED JavaScript exception',
        ),
      );
    if (kind === 'console-error')
      value.page.emit('console', {
        type: () => 'error',
        text: () => 'Failed to load resource: net::ERR_ABORTED',
        location: () => ({
          url: causalReplayOrigin + '/favicon.ico',
          lineNumber: 0,
          columnNumber: 0,
        }),
        timestamp: () => 1,
      });
    if (kind === 'network-log-error')
      value.session.emit('Log.entryAdded', {
        entry: {
          level: 'error',
          source: 'network',
          networkRequestId: 'icon',
          text: 'net::ERR_ABORTED',
        },
      });
    if (kind === 'nonfixture403' || kind === 'unplanned-abort') {
      value.session.emit('Network.requestWillBeSent', {
        requestId: 'unplanned',
        request: { url: 'http://untrusted.invalid/favicon.ico', method: 'GET' },
      });
      if (kind === 'nonfixture403')
        value.session.emit('Network.responseReceived', {
          requestId: 'unplanned',
          response: { status: 403 },
        });
      else
        value.session.emit('Network.loadingFailed', {
          requestId: 'unplanned',
          type: 'Other',
          errorText: 'net::ERR_ABORTED',
          canceled: true,
          timestamp: 4,
        });
    }
    const count = journal.events.length;
    expect(() => trace.assertClean()).toThrow('Unclassified');
    expect(journal.events).toHaveLength(count);
    expect(trace.cdpFailures).toHaveLength(kind === 'unplanned-abort' ? 2 : 1);
    if (kind !== 'unplanned-abort') expect(trace.errors).toHaveLength(1);
    await trace.close();
    expect(trace.cdpFailures).toHaveLength(kind === 'unplanned-abort' ? 2 : 1);
  });
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
