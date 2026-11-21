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
  const nodes = new Map(
    [...value.ancestors, ...value.nodes].map((node) => [node.identity, node]),
  );
  const under = (child: number, parent: number): boolean => {
    const visited = new Set<number>();
    for (let id: number | null = child; id !== null;) {
      if (id === parent) return true;
      if (visited.has(id)) fail('cyclic subject ancestry');
      visited.add(id);
      id = nodes.get(id)?.parentIdentity ?? null;
    }
    return false;
  };
  const inRect = (x: number, y: number, r: typeof root) =>
    x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  const noExtraPaint = (node: PanelsCausalSnapshot['nodes'][number]) =>
    [
      'filter',
      'backdrop-filter',
      'box-shadow',
      'mask-image',
      'clip-path',
      'border-image-source',
    ].every((key) => node.styles[key] === 'none') &&
    node.styles['outline-style'] === 'none' &&
    ['none', 'normal'].includes(node.before.content!) &&
    ['none', 'normal'].includes(node.after.content!);
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
    const subjectNode = nodes.get(subject.identity);
    if (!subjectNode || !contentIds.has(subject.identity))
      fail('unknown subject identity');
    if (
      subject.coordinateSpace !== (subjectNode!.matrix ? 'svg' : 'border-box')
    )
      fail('subject sample point coordinate space mismatch');
    const frame =
      subject.coordinateSpace === 'svg'
        ? subjectNode!.bbox
        : { x: 0, y: 0, width: r.width, height: r.height };
    const matrix =
      subject.coordinateSpace === 'svg' ? subjectNode!.matrix : null;
    if (!frame || (subject.coordinateSpace === 'svg' && !matrix))
      fail('subject sample point frame missing');
    const sx = Math.min(1, frame!.width / 2),
      sy = Math.min(1, frame!.height / 2);
    const points = [
      [sx, sy],
      [frame!.width - sx, sy],
      [sx, frame!.height - sy],
      [frame!.width - sx, frame!.height - sy],
      [frame!.width / 2, frame!.height / 2],
    ];
    for (const [index, hit] of subject.hits.entries()) {
      const x = frame!.x + points[index]![0]!,
        y = frame!.y + points[index]![1]!;
      if (
        hit.local.x !== x ||
        hit.local.y !== y ||
        hit.x !== (matrix ? matrix.a * x + matrix.c * y + matrix.e : r.x + x) ||
        hit.y !== (matrix ? matrix.b * x + matrix.d * y + matrix.f : r.y + y)
      )
        fail('subject sample point changed');
      const target = hit.element!;
      const relation =
        target.identity === subject.identity
          ? 'self'
          : under(target.identity, subject.identity)
            ? 'descendant'
            : under(subject.identity, target.identity)
              ? 'ancestor'
              : 'unrelated';
      if (relation !== hit.relation || relation === 'unrelated')
        fail('subject hit ownership is unrelated or mislabeled');
      if (relation !== 'ancestor') {
        if (hit.blank !== null)
          fail('subject hit carries unexpected blank evidence');
        continue;
      }
      if (!hit.blank) fail('ancestor subject hit lacks blank evidence');
      const subtree = value.nodes.filter((node) =>
        under(node.identity, subject.identity),
      );
      const svgNodes = subtree.filter((node) => node.matrix !== null);
      const expectedGeometry = svgNodes.filter((node) => node.svgGeometry);
      const tests = hit.blank!.geometries;
      if (
        new Set(tests.map((test) => test.identity)).size !== tests.length ||
        JSON.stringify(tests.map((test) => test.identity)) !==
          JSON.stringify(expectedGeometry.map((node) => node.identity)) ||
        svgNodes.some(
          (node) =>
            (!node.svgGeometry && !['svg', 'g'].includes(node.tag)) ||
            !noExtraPaint(node) ||
            node.styles['background-color'] !== 'rgba(0, 0, 0, 0)' ||
            node.styles['background-image'] !== 'none' ||
            node.styles['border-width'] !== '0px' ||
            node.styles.opacity !== '1',
        ) ||
        tests.some((test) => {
          const shape = nodes.get(test.identity)!;
          return (
            !Number.isFinite(test.local.x) ||
            !Number.isFinite(test.local.y) ||
            typeof test.fill !== 'boolean' ||
            typeof test.stroke !== 'boolean' ||
            (shape.styles.fill !== 'none' && test.fill) ||
            (shape.styles.stroke !== 'none' && test.stroke)
          );
        })
      )
        fail('ancestor subject hit is not proved SVG blank');
      if (hit.blank!.kind === 'svg-blank') {
        if (
          subject.coordinateSpace !== 'svg' ||
          !expectedGeometry.length ||
          svgNodes.length !== subtree.length
        )
          fail('ancestor subject hit has incomplete SVG geometry');
        continue;
      }
      if (
        subject.coordinateSpace !== 'border-box' ||
        subjectNode!.styles['corner-shape'] !== 'round' ||
        !noExtraPaint(subjectNode!)
      )
        fail('ancestor subject hit is not a standard round cutout');
      // Only unscaled, axis-aligned CSS boxes support this border-radius test.
      for (
        let node = subjectNode;
        node;
        node =
          node.parentIdentity === null
            ? undefined
            : nodes.get(node.parentIdentity)
      ) {
        const s = node.styles;
        const transform =
          s.transform === 'none' ||
          /^matrix\(1, 0, 0, 1, [-\d.e+]+, [-\d.e+]+\)$/.test(s.transform!);
        if (
          !transform ||
          !['none', '0deg'].includes(s.rotate!) ||
          !['none', '1', '1 1', '1 1 1'].includes(s.scale!) ||
          s.zoom !== '1'
        )
          fail(
            'ancestor subject hit round frame is not an unscaled translation',
          );
      }
      const radius = (text: string | undefined, size: number) => {
        if (!text || !/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%)$/.test(text))
          fail('unknown subject hit radius');
        return parseFloat(text!) * (text!.endsWith('%') ? size / 100 : 1);
      };
      const radii = [
        'top-left',
        'top-right',
        'bottom-right',
        'bottom-left',
      ].map((corner) => {
        const pair =
          subjectNode!.styles['border-' + corner + '-radius']?.split(' ');
        return [
          radius(pair?.[0], r.width),
          radius(pair?.[1] ?? pair?.[0], r.height),
        ];
      });
      const factor = Math.min(
        1,
        r.width / (radii[0]![0]! + radii[1]![0]!),
        r.width / (radii[3]![0]! + radii[2]![0]!),
        r.height / (radii[0]![1]! + radii[3]![1]!),
        r.height / (radii[1]![1]! + radii[2]![1]!),
      );
      const outside = radii.some(([rx, ry], corner) => {
        const a = rx! * factor,
          b = ry! * factor;
        const px =
          corner === 0 || corner === 3 ? hit.local.x : r.width - hit.local.x;
        const py = corner < 2 ? hit.local.y : r.height - hit.local.y;
        return (
          a > 0 &&
          b > 0 &&
          px < a &&
          py < b &&
          ((px - a) / a) ** 2 + ((py - b) / b) ** 2 > 1
        );
      });
      if (
        !outside ||
        hit.blank!.textRects.some((text) => inRect(hit.x, hit.y, text)) ||
        subtree.some(
          (node) =>
            node.identity !== subject.identity &&
            !node.matrix &&
            (!noExtraPaint(node) || inRect(hit.x, hit.y, node.rect)),
        )
      )
        fail('ancestor subject hit lacks a clear round cutout');
    }
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
  for (let i = 0; i < before.sampling.subjects.length; i++) {
    const a = before.sampling.subjects[i]!,
      b = after.sampling.subjects[i]!;
    if (a.coordinateSpace !== b.coordinateSpace)
      fail('subject sample point frame changed');
    if (a.coordinateSpace === 'svg') {
      const aNode = before.nodes.find((node) => node.identity === a.identity)!,
        bNode = after.nodes.find((node) => node.identity === b.identity)!;
      if (
        JSON.stringify(aNode.bbox) !== JSON.stringify(bNode.bbox) ||
        (['a', 'b', 'c', 'd'] as const).some(
          (key) => aNode.matrix![key] !== bNode.matrix![key],
        ) ||
        bNode.matrix!.e - aNode.matrix!.e !== dx ||
        bNode.matrix!.f - aNode.matrix!.f !== dy
      )
        fail('subject sample point SVG frame changed');
    } else if (
      b.rect.x - a.rect.x !== dx ||
      b.rect.y - a.rect.y !== dy ||
      b.rect.width !== a.rect.width ||
      b.rect.height !== a.rect.height
    )
      fail('subject sample point box frame changed');
    for (let p = 0; p < a.hits.length; p++) {
      const x = a.hits[p]!,
        y = b.hits[p]!;
      // Both snapshots checked the actual world point against this local frame.
      // Compare local points plus the exact frame translation, not float32 SVG bounds.
      if (
        JSON.stringify(x.local) !== JSON.stringify(y.local) ||
        x.relation !== y.relation ||
        x.element?.identity !== y.element?.identity ||
        x.blank?.kind !== y.blank?.kind ||
        JSON.stringify(
          x.blank?.geometries.map(({ identity, fill, stroke }) => ({
            identity,
            fill,
            stroke,
          })),
        ) !==
          JSON.stringify(
            y.blank?.geometries.map(({ identity, fill, stroke }) => ({
              identity,
              fill,
              stroke,
            })),
          )
      )
        fail(
          'subject hit identity/relation or normalized sample point changed',
        );
    }
  }
  for (let i = 0; i < before.nodes.length; i++) {
    const a = before.nodes[i]!,
      b = after.nodes[i]!;
    if (
      a.identity !== b.identity ||
      a.parentIdentity !== b.parentIdentity ||
      a.svgGeometry !== b.svgGeometry ||
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
