import type { PanelsCausalSnapshot } from './employee-panels-causal-dom';

type Capture = 'formalElement' | 'fullFramePanelWindow';
type Pixels = Record<Capture, { changedPixels: number | null }>;

/** Same-run pixel dependency, never a product repair or reference-match claim. */
export function classifyNativePlacementEffect(
  valid: boolean,
  values: {
    baseline: Pixels | null;
    transform: Pixels | null;
    layout: Pixels | null;
    returned: Pixels | null;
    mechanism: Pixels | null;
  },
  exactReturn: Record<Capture, boolean>,
) {
  const capture = (kind: Capture) => {
    const counts = {
      baseline: values.baseline?.[kind].changedPixels ?? null,
      transform: values.transform?.[kind].changedPixels ?? null,
      layout: values.layout?.[kind].changedPixels ?? null,
      returned: values.returned?.[kind].changedPixels ?? null,
      mechanism: values.mechanism?.[kind].changedPixels ?? null,
    };
    const missing = Object.values(counts).some(
      (n) => n === null || !Number.isInteger(n) || n < 0,
    );
    const status =
      !valid ||
      missing ||
      !exactReturn[kind] ||
      counts.returned !== counts.transform ||
      (counts.mechanism === 0 && counts.transform !== counts.layout)
        ? 'invalid-experiment'
        : counts.mechanism === 0
          ? 'no-observable-effect'
          : counts.baseline === 0
            ? 'not-supported'
            : 'supported';
    return {
      status,
      ...counts,
      exactReturn: exactReturn[kind],
      mechanismPixelsDiffer: counts.mechanism !== null && counts.mechanism > 0,
      currentBaselineHasResidual:
        counts.baseline !== null && counts.baseline > 0,
    };
  };
  const captures = {
    formalElement: capture('formalElement'),
    fullFramePanelWindow: capture('fullFramePanelWindow'),
  };
  const statuses = Object.values(captures).map((item) => item.status);
  const status = statuses.includes('invalid-experiment')
    ? 'invalid-experiment'
    : statuses.every((value) => value === 'supported')
      ? 'supported'
      : statuses.every((value) => value === 'no-observable-effect')
        ? 'no-observable-effect'
        : 'not-supported';
  return {
    status,
    captures,
    supportsSameRunNativePixelDependency: status === 'supported',
    provesProductRepair: false,
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fail = (message: string): never => {
  throw Error('Invalid native placement experiment: ' + message);
};

/** The one extra ancestor must be the test-owned host around the same app. */
export function placementWrapperIdentity(
  before: PanelsCausalSnapshot,
  attached: PanelsCausalSnapshot,
) {
  const oldIds = new Set(before.ancestors.map((node) => node.identity));
  const extras = attached.ancestors.filter(
    (node) => !oldIds.has(node.identity),
  );
  if (extras.length !== 1) fail('not exactly one new owned ancestor');
  const wrapper = extras[0]!;
  const index = attached.ancestors.indexOf(wrapper);
  const app = attached.ancestors[index - 1];
  const oldApp = before.ancestors[index - 1];
  if (
    !app ||
    !oldApp ||
    app.identity !== oldApp.identity ||
    app.parentIdentity !== wrapper.identity ||
    wrapper.parentIdentity !== oldApp.parentIdentity ||
    wrapper.tag !== 'DIV' ||
    wrapper.className !== null ||
    wrapper.styles.position !== 'relative' ||
    wrapper.styles.transform !== 'matrix(1, 0, 0, 1, 0, 0)' ||
    !same(wrapper.rect, oldApp.rect)
  )
    fail('host is not the planned identity wrapper around the same app');
  const normalized = attached.ancestors
    .filter((node) => node.identity !== wrapper.identity)
    .map((node) =>
      node.identity === app!.identity
        ? { ...node, parentIdentity: oldApp!.parentIdentity }
        : node,
    );
  if (!same(before.ancestors, normalized))
    fail('existing ancestor geometry/clip/paint changed during attachment');
  return wrapper.identity;
}

/** Fixed viewport coordinates: only this host's known transform matrix differs.
 * Every ancestor box, clip/paint field, identity and state otherwise stays exact. */
export function assertPlacementAncestors(
  transform: PanelsCausalSnapshot,
  layout: PanelsCausalSnapshot,
  wrapperIdentity: number,
  offset: { x: number; y: number },
) {
  const allowed = [
    'matrix(1, 0, 0, 1, 0, 0)',
    `matrix(1, 0, 0, 1, ${offset.x}, ${offset.y})`,
  ];
  const normalized = (value: PanelsCausalSnapshot) => {
    const wrappers = value.ancestors.filter(
      (node) => node.identity === wrapperIdentity,
    );
    if (wrappers.length !== 1) fail('owned ancestor identity lost');
    if (!allowed.includes(wrappers[0]!.styles.transform!))
      fail('unplanned host transform');
    return value.ancestors.map((node) =>
      node.identity === wrapperIdentity
        ? {
            ...node,
            styles: { ...node.styles, transform: '<owned placement matrix>' },
          }
        : node,
    );
  };
  if (!same(normalized(transform), normalized(layout)))
    fail('fixed-origin ancestor geometry/clip/paint/state changed');
}
