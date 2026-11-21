import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';

/** A paint-sampling scope, never a waiver of full-root/acceptance pixels. */
export function assertCausalSampling(value: PanelsCausalSnapshot) {
  const fail = (message: string): never => {
    throw Error('Invalid causal sampling: ' + message);
  };
  const { root, sampling } = value;
  if (!sampling.clipBudgetVisible) fail('content clipped');
  const { resize, interior, raw } = sampling;
  if (!sampling.subjects.length) fail('no recorded rounded/SVG subjects');
  const contentIds = new Set(value.nodes.map((node) => node.identity));
  for (const hit of [
    ...raw,
    ...sampling.interiorHits,
    ...sampling.subjects.flatMap((subject) => subject.hits),
  ])
    if (
      hit.rootContains &&
      (!hit.element || !contentIds.has(hit.element.identity))
    )
      fail('positive hit lacks a recorded content identity');
  if (
    JSON.stringify(value.hits) !==
      JSON.stringify(raw.map((hit) => hit.rootContains)) ||
    value.unclipped !==
      (sampling.clipBudgetVisible && value.hits.every(Boolean))
  )
    fail('raw full-root verdict was relabeled');
  if (raw.length !== 5 || sampling.interiorHits.length !== 5)
    fail('incomplete hit evidence');
  if (!resize) {
    if (!value.unclipped || raw.some((hit) => !hit.rootContains))
      fail('unrecognized occlusion');
    if (JSON.stringify(interior) !== JSON.stringify(root))
      fail('unregistered sampling exclusion');
  } else {
    const { control, rightbar } = resize,
      r = control.rect,
      s = control.styles;
    if (
      resize.count !== 1 ||
      !resize.empty ||
      control.tag !== 'DIV' ||
      control.attributes['data-side'] !== 'rightbar' ||
      'data-dragging' in control.attributes ||
      r.width !== 8 ||
      r.x + r.width / 2 !== rightbar.x ||
      r.x >= root.x ||
      r.x + r.width <= root.x ||
      r.x + r.width >= root.x + root.width ||
      r.y > root.y ||
      r.y + r.height < root.y + root.height ||
      s.position !== 'absolute' ||
      s.cursor !== 'col-resize' ||
      s['pointer-events'] !== 'auto' ||
      s['z-index'] !== '11' ||
      s.visibility !== 'visible' ||
      s.opacity !== '1' ||
      s['background-color'] !== 'rgba(0, 0, 0, 0)' ||
      s['background-image'] !== 'none' ||
      s['border-width'] !== '0px' ||
      s['border-image-source'] !== 'none' ||
      s['box-shadow'] !== 'none' ||
      s['outline-style'] !== 'none' ||
      s.filter !== 'none' ||
      s['backdrop-filter'] !== 'none' ||
      s['mask-image'] !== 'none' ||
      s['clip-path'] !== 'none' ||
      control.animations.length ||
      !['none', 'normal'].includes(control.before.content!) ||
      !['none', 'normal'].includes(control.after.content!)
    )
      fail('not the unchanged transparent native resize control');
    if (
      interior.x !== r.x + r.width ||
      interior.y !== root.y ||
      interior.width !== root.x + root.width - interior.x ||
      interior.height !== root.height
    )
      fail('sampling exclusion does not match the recorded control');
    const misses = raw.filter((hit) => !hit.rootContains);
    if (
      misses.length !== 2 ||
      misses.some(
        (hit) =>
          hit.element?.identity !== control.identity ||
          hit.element.attributes['data-side'] !== 'rightbar' ||
          hit.x < r.x ||
          hit.x >= r.x + r.width ||
          hit.y < r.y ||
          hit.y >= r.y + r.height,
      )
    )
      fail('raw miss is not the registered resize control');
  }
  if (sampling.interiorHits.some((hit) => !hit.rootContains))
    fail('interior occluded');
  for (const subject of sampling.subjects) {
    const r = subject.rect;
    if (
      r.x < interior.x ||
      r.y < interior.y ||
      r.x + r.width > interior.x + interior.width ||
      r.y + r.height > interior.y + interior.height ||
      subject.hits.length !== 5 ||
      subject.hits.some((hit) => !hit.rootContains)
    )
      fail('rounded/SVG subject crosses the unproved strip or is occluded');
  }
}

/** No pixel tolerance. These checks determine whether an experiment is valid. */
export function assertCausalInvariant(
  before: PanelsCausalSnapshot,
  after: PanelsCausalSnapshot,
  change: { x?: number; y?: number; hover?: boolean; corner?: boolean } = {},
) {
  const fail = (message: string): never => {
    throw Error('Invalid causal experiment: ' + message);
  };
  assertCausalSampling(before);
  assertCausalSampling(after);
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
    before.nodes.length !== after.nodes.length ||
    JSON.stringify(
      before.sampling.subjects.map((subject) => subject.identity),
    ) !==
      JSON.stringify(after.sampling.subjects.map((subject) => subject.identity))
  )
    fail('focus or node set changed');
  const aControl = before.sampling.resize,
    bControl = after.sampling.resize;
  if (!!aControl !== !!bControl) fail('resize control set changed');
  if (aControl && bControl) {
    if (
      aControl.control.identity !== bControl.control.identity ||
      aControl.rightbarIdentity !== bControl.rightbarIdentity ||
      aControl.control.className !== bControl.control.className ||
      aControl.control.hovered !== bControl.control.hovered ||
      aControl.control.focused !== bControl.control.focused ||
      JSON.stringify(aControl.control.attributes) !==
        JSON.stringify(bControl.control.attributes) ||
      JSON.stringify(aControl.control.styles) !==
        JSON.stringify(bControl.control.styles) ||
      JSON.stringify(aControl.control.before) !==
        JSON.stringify(bControl.control.before) ||
      JSON.stringify(aControl.control.after) !==
        JSON.stringify(bControl.control.after) ||
      bControl.control.rect.x - aControl.control.rect.x !== dx ||
      bControl.control.rect.y - aControl.control.rect.y !== dy ||
      bControl.control.rect.width !== aControl.control.rect.width ||
      bControl.control.rect.height !== aControl.control.rect.height ||
      bControl.rightbar.x - aControl.rightbar.x !== dx ||
      bControl.rightbar.y - aControl.rightbar.y !== dy ||
      bControl.rightbar.width !== aControl.rightbar.width ||
      bControl.rightbar.height !== aControl.rightbar.height
    )
      fail('resize control identity/paint/geometry changed');
  }
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i]!,
      b = after.nodes[i]!;
    if (
      a.identity !== b.identity ||
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
