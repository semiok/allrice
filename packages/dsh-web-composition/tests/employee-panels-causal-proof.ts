import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';

/** No pixel tolerance. These checks determine whether an experiment is valid. */
export function assertCausalInvariant(
  before: PanelsCausalSnapshot,
  after: PanelsCausalSnapshot,
  change: { x?: number; y?: number; hover?: boolean; corner?: boolean } = {},
) {
  const fail = (message: string): never => {
    throw Error('Invalid causal experiment: ' + message);
  };
  if (!before.unclipped || !after.unclipped)
    fail('content clipped or occluded');
  const dx = change.x ?? 0,
    dy = change.y ?? 0;
  if (
    after.root.x - before.root.x !== dx ||
    after.root.y - before.root.y !== dy ||
    after.root.width !== before.root.width ||
    after.root.height !== before.root.height
  )
    fail('root geometry changed beyond the one planned translation');
  if (
    before.active !== after.active ||
    before.nodes.length !== after.nodes.length
  )
    fail('focus or node set changed');
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i]!,
      b = after.nodes[i]!;
    if (
      a.tag !== b.tag ||
      a.className !== b.className ||
      a.text !== b.text ||
      a.focused !== b.focused ||
      (!change.hover && a.hovered !== b.hovered)
    )
      fail(`node ${i} identity/state changed`);
    if (a.animations.length || b.animations.length)
      fail(`node ${i} has an active animation`);
    for (const part of ['styles', 'before', 'after'] as const)
      for (const key of new Set([
        ...Object.keys(a[part]),
        ...Object.keys(b[part]),
      ])) {
        if (change.corner && key === '--dsw-corner-shape') continue;
        if (a[part][key] !== b[part][key])
          fail(`node ${i} ${part}.${key} changed`);
      }
    if (change.corner && b.styles['corner-shape'] !== 'round')
      fail(`node ${i} no longer round`);
    // SVG path/g world bounds are float32-sensitive. Check the exact local shape
    // and screen matrix instead of inventing a new pixel epsilon for those bounds.
    if (a.tag === 'path' || a.tag === 'g') {
      if (
        !a.matrix ||
        !b.matrix ||
        JSON.stringify(a.bbox) !== JSON.stringify(b.bbox)
      )
        fail(`node ${i} SVG shape changed`);
      for (const key of ['a', 'b', 'c', 'd'] as const)
        if (a.matrix![key] !== b.matrix![key])
          fail(`node ${i} SVG scale changed`);
      if (b.matrix!.e - a.matrix!.e !== dx || b.matrix!.f - a.matrix!.f !== dy)
        fail(`node ${i} SVG translation changed`);
    } else if (
      b.rect.x - a.rect.x !== dx ||
      b.rect.y - a.rect.y !== dy ||
      b.rect.width !== a.rect.width ||
      b.rect.height !== a.rect.height
    )
      fail(`node ${i} deformed`);
  }
}

export function assertToolFaviconOutcome(value: {
  mode: 'OFF' | 'ON';
  starts: number;
  method: string;
  status?: number;
  finished?: boolean;
  failure?: string;
  canceled?: boolean;
  routeEntries: number;
  serverHits: number;
  unknownErrors: number;
}) {
  if (value.starts !== 1 || value.method !== 'GET' || value.unknownErrors)
    throw Error('Incomplete or ambiguous tool-only favicon experiment');
  if (value.mode === 'OFF') {
    if (
      value.status !== 200 ||
      !value.finished ||
      value.failure ||
      value.routeEntries ||
      value.serverHits !== 1
    )
      throw Error('OFF did not complete the real HTTP ICO response');
  } else if (
    value.status !== undefined ||
    value.finished ||
    value.failure !== 'net::ERR_ABORTED' ||
    value.canceled !== true ||
    value.routeEntries ||
    value.serverHits
  )
    throw Error('ON did not prove cancellation before user route/server');
}
