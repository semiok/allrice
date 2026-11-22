import { crc32, deflateSync } from 'node:zlib';
import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';
import { screenshotPixels } from './sidebar-pixels';

type OriginCapture = 'formalElement' | 'fullFramePanelWindow';
type OriginPixels = Record<OriginCapture, { changedPixels: number | null }>;

/** Causality needs this run's observable zero → aligned → returned contrast.
 * Return reproduction uses captured reference PNG byte equality, not counts alone. */
export function classifyPanelsOriginEffect(
  valid: boolean,
  comparisons: {
    atZero: OriginPixels | null;
    aligned: OriginPixels | null;
    returned: OriginPixels | null;
  },
  returnedMatchesZero: Record<OriginCapture, boolean>,
) {
  const capture = (kind: OriginCapture) => {
    const atZero = comparisons.atZero?.[kind].changedPixels ?? null,
      aligned = comparisons.aligned?.[kind].changedPixels ?? null,
      returned = comparisons.returned?.[kind].changedPixels ?? null;
    const reproduced = returnedMatchesZero[kind] && returned === atZero;
    const status =
      !valid || atZero === null || aligned === null || returned === null
        ? 'invalid-experiment'
        : atZero === 0 && aligned === 0 && returned === 0 && reproduced
          ? 'no-observable-effect'
          : atZero > 0 && aligned === 0 && reproduced
            ? 'supported'
            : 'not-supported';
    return {
      status,
      atZero,
      aligned,
      returned,
      returnedMatchesZero: returnedMatchesZero[kind],
    };
  };
  const captures = {
    formalElement: capture('formalElement'),
    fullFramePanelWindow: capture('fullFramePanelWindow'),
  };
  const values = Object.values(captures);
  const status = values.some((value) => value.status === 'invalid-experiment')
    ? 'invalid-experiment'
    : values.every((value) => value.status === 'supported')
      ? 'supported'
      : values.every((value) => value.status === 'no-observable-effect')
        ? 'no-observable-effect'
        : 'not-supported';
  return { status, captures, supportsReferenceOrigin: status === 'supported' };
}

/** A lossless derived view of saved full-frame pixels, not a second capture. */
export function cropPanelsOriginFrame(
  png: Buffer,
  rect: PanelsCausalSnapshot['root'],
) {
  const image = screenshotPixels(png);
  if (
    !Object.values(rect).every(Number.isInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width > image.width ||
    rect.y + rect.height > image.height
  )
    throw Error(
      'Panel window must be an exact integer rectangle inside the saved frame',
    );
  const raw = Buffer.alloc((rect.width * 4 + 1) * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const start = ((rect.y + y) * image.width + rect.x) * 4;
    image.rgba.copy(
      raw,
      y * (rect.width * 4 + 1) + 1,
      start,
      start + rect.width * 4,
    );
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(rect.width, 0);
  header.writeUInt32BE(rect.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Preserve every measured cross-side difference, including the known raw token.
 * Identities/classes belong to distinct mounts; no paint property is normalized. */
export function comparePanelsOriginContent(
  native: PanelsCausalSnapshot,
  reference: PanelsCausalSnapshot,
) {
  const differences: {
    node: number;
    field: string;
    native: unknown;
    reference: unknown;
  }[] = [];
  const compare = (node: number, field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      differences.push({ node, field, native: a, reference: b });
  };
  compare(-1, 'node-count', native.nodes.length, reference.nodes.length);
  for (
    let i = 0;
    i < Math.min(native.nodes.length, reference.nodes.length);
    i++
  ) {
    const a = native.nodes[i]!,
      b = reference.nodes[i]!;
    for (const key of [
      'tag',
      'text',
      'focused',
      'hovered',
      'bbox',
      'animations',
    ] as const)
      compare(i, key, a[key], b[key]);
    compare(
      i,
      'local-rect',
      { ...a.rect, x: a.rect.x - native.root.x, y: a.rect.y - native.root.y },
      {
        ...b.rect,
        x: b.rect.x - reference.root.x,
        y: b.rect.y - reference.root.y,
      },
    );
    for (const part of ['styles', 'before', 'after'] as const)
      for (const key of new Set([
        ...Object.keys(a[part]),
        ...Object.keys(b[part]),
      ]))
        compare(i, part + '.' + key, a[part][key], b[part][key]);
    compare(
      i,
      'local-svg-matrix',
      a.matrix && {
        ...a.matrix,
        e: a.matrix.e - native.root.x,
        f: a.matrix.f - native.root.y,
      },
      b.matrix && {
        ...b.matrix,
        e: b.matrix.e - reference.root.x,
        f: b.matrix.f - reference.root.y,
      },
    );
  }
  return differences;
}
