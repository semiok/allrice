/** Browser-only diagnostic fixture. Owns its wrapper; never accesses DSH objects. */
export function createPanelsCausalDom() {
  const properties = [
    'display',
    'position',
    'box-sizing',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'color',
    'background',
    'border-radius',
    'border-width',
    'border-color',
    'border-style',
    'corner-shape',
    '--dsw-corner-shape',
    'opacity',
    'transform',
    'translate',
    'scale',
    'rotate',
    'filter',
    'backdrop-filter',
    'will-change',
    'contain',
    'isolation',
    'mix-blend-mode',
    'mask-image',
    'clip-path',
    'box-shadow',
    'color-scheme',
    'zoom',
    '-webkit-font-smoothing',
    'text-autospace',
    'overflow-x',
    'overflow-y',
    'overflow-clip-margin',
    'clip',
    'backface-visibility',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'shape-rendering',
    'vector-effect',
    'color-interpolation',
  ];
  const rect = (element: Element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  };
  const styles = (element: Element, pseudo?: string) => {
    const value = getComputedStyle(element, pseudo);
    return Object.fromEntries(
      properties.map((key) => [key, value.getPropertyValue(key)]),
    );
  };
  const content = () => {
    const nodes = [
      ...document.querySelectorAll('section[aria-label="Rice · 记忆"]'),
    ].filter((node) => rect(node).width > 0 && rect(node).height > 0);
    if (nodes.length !== 1)
      throw Error('Diagnostic requires exactly one real visible memory panel');
    return nodes[0]!;
  };
  const node = (element: Element) => {
    const svg = element instanceof SVGGraphicsElement;
    const bbox = svg ? element.getBBox() : null;
    const matrix = svg ? element.getScreenCTM() : null;
    return {
      tag: element.tagName,
      className: element.getAttribute('class'),
      text: element.textContent?.slice(0, 180),
      rect: rect(element),
      styles: styles(element),
      before: styles(element, '::before'),
      after: styles(element, '::after'),
      hovered: element.matches(':hover'),
      focused: document.activeElement === element,
      bbox: bbox && {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      },
      matrix: matrix && {
        a: matrix.a,
        b: matrix.b,
        c: matrix.c,
        d: matrix.d,
        e: matrix.e,
        f: matrix.f,
      },
      animations: element.getAnimations().map((animation) => ({
        state: animation.playState,
        time: animation.currentTime,
      })),
    };
  };
  const styleAttribute = (element: Element) => ({
    present: element.hasAttribute('style'),
    text: element.getAttribute('style'),
  });
  const sameStyle = (
    a: ReturnType<typeof styleAttribute>,
    b: ReturnType<typeof styleAttribute>,
  ) => a.present === b.present && a.text === b.text;
  let owned:
    | {
        wrapper: HTMLDivElement;
        wrapperStyle: string | null;
        app: HTMLElement;
        parent: HTMLElement;
        next: ChildNode | null;
        panel: Element;
        surface: HTMLElement;
        nonce: string;
        corner: string;
        priority: string;
        originalStyle: ReturnType<typeof styleAttribute>;
        expectedStyle: ReturnType<typeof styleAttribute>;
        styleObserver: MutationObserver;
        externalStyleChanges: (string | null)[];
      }
    | undefined;
  const ownershipFailure = (
    state: NonNullable<typeof owned>,
    partial = false,
  ) => {
    const { wrapper, app, parent, next, panel, surface, nonce } = state;
    state.externalStyleChanges.push(
      ...state.styleObserver.takeRecords().map((record) => record.oldValue),
    );
    if (
      parent !== document.body ||
      wrapper.dataset.allriceCausalContainer !== nonce ||
      wrapper.attributes.length !== 2 ||
      wrapper.getAttribute('style') !== state.wrapperStyle ||
      !app.contains(surface) ||
      panel.parentElement !== surface ||
      !surface.isConnected
    )
      return 'Wrapper or AllRice surface identity changed';
    if (
      state.externalStyleChanges.length ||
      !sameStyle(styleAttribute(surface), state.expectedStyle)
    )
      return 'External surface style change; refuse overwriting it';
    const wrapped =
      wrapper.parentNode === parent &&
      app.parentNode === wrapper &&
      wrapper.childNodes.length === 1 &&
      wrapper.nextSibling === next;
    const beforeAttach =
      app.parentNode === parent &&
      app.nextSibling === next &&
      wrapper.childNodes.length === 0 &&
      (!wrapper.parentNode ||
        (wrapper.parentNode === parent && wrapper.nextSibling === app));
    if (!wrapped && !(partial && beforeAttach))
      return 'Original DOM parent/order changed; refuse destructive rollback';
    return undefined;
  };
  const restoreSurfaceStyle = (state: NonNullable<typeof owned>) => {
    const { surface, originalStyle } = state;
    if (originalStyle.present)
      surface.setAttribute('style', originalStyle.text!);
    else surface.removeAttribute('style');
    // Only this synchronous owned mutation is drained. Every mutation between
    // operations, including change-then-revert, is external and refuses cleanup.
    state.styleObserver.takeRecords();
    state.expectedStyle = styleAttribute(surface);
    if (
      !sameStyle(state.expectedStyle, originalStyle) ||
      surface.style.getPropertyValue('--dsw-corner-shape') !== state.corner ||
      surface.style.getPropertyPriority('--dsw-corner-shape') !== state.priority
    )
      throw Error('Surface style attribute was not restored exactly');
    return { originalStyle, actualStyle: state.expectedStyle };
  };
  return {
    snapshot() {
      const root = content(),
        box = rect(root),
        ancestors = [];
      let visible =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= innerWidth &&
        box.y + box.height <= innerHeight;
      for (
        let parent = root.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        ancestors.push(node(parent));
        const r = rect(parent),
          s = getComputedStyle(parent);
        if (!r.width || !r.height) continue; // display:contents owns no clip box.
        if (['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowX))
          visible &&=
            box.x >= r.x + parent.clientLeft &&
            box.x + box.width <= r.x + parent.clientLeft + parent.clientWidth;
        if (['hidden', 'clip', 'auto', 'scroll'].includes(s.overflowY))
          visible &&=
            box.y >= r.y + parent.clientTop &&
            box.y + box.height <= r.y + parent.clientTop + parent.clientHeight;
      }
      const hits = [
        [1, 1],
        [box.width - 1, 1],
        [1, box.height - 1],
        [box.width - 1, box.height - 1],
        [box.width / 2, box.height / 2],
      ].map(([x, y]) =>
        root.contains(document.elementFromPoint(box.x + x!, box.y + y!)),
      );
      return {
        root: box,
        nodes: [root, ...root.querySelectorAll('*')]
          .filter((el) => rect(el).width > 0 && rect(el).height > 0)
          .map(node),
        ancestors,
        unclipped: visible && hits.every(Boolean),
        hits,
        active: document.activeElement?.tagName,
        pointerOutside: !root.contains(document.elementFromPoint(720, 0)),
      };
    },
    attach(nonce: string) {
      if (owned) throw Error('Diagnostic wrapper already allocated');
      const panel = content(),
        surface = panel.parentElement;
      if (
        !surface ||
        getComputedStyle(surface)
          .getPropertyValue('--dsw-corner-shape')
          .trim() !== 'round'
      )
        throw Error('Expected the existing AllRice surface boundary');
      let app = panel as HTMLElement;
      while (app.parentElement && app.parentElement !== document.body)
        app = app.parentElement;
      if (app.parentElement !== document.body)
        throw Error('No isolated application root');
      const wrapper = document.createElement('div');
      wrapper.dataset.allriceCausalContainer = nonce;
      wrapper.style.cssText = 'width:100%;height:100%;min-height:0;';
      const originalStyle = styleAttribute(surface);
      const externalStyleChanges: (string | null)[] = [];
      const styleObserver = new MutationObserver((records) => {
        externalStyleChanges.push(...records.map((record) => record.oldValue));
      });
      // Capture ownership before the first DOM mutation, including partial setup.
      owned = {
        wrapper,
        wrapperStyle: wrapper.getAttribute('style'),
        app,
        parent: document.body,
        next: app.nextSibling,
        panel,
        surface,
        nonce,
        corner: surface.style.getPropertyValue('--dsw-corner-shape'),
        priority: surface.style.getPropertyPriority('--dsw-corner-shape'),
        originalStyle,
        expectedStyle: originalStyle,
        styleObserver,
        externalStyleChanges,
      };
      styleObserver.observe(surface, {
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true,
      });
      document.body.insertBefore(wrapper, app);
      wrapper.append(app);
      return { originalStyle };
    },
    transform(value: string | null) {
      if (!owned) throw Error('Lost own diagnostic wrapper');
      const refusal = ownershipFailure(owned);
      if (refusal) throw Error(refusal);
      if (value === null) owned.wrapper.style.removeProperty('transform');
      else owned.wrapper.style.transform = value;
      owned.wrapperStyle = owned.wrapper.getAttribute('style');
    },
    corner(initial: boolean) {
      if (!owned) throw Error('Lost own diagnostic wrapper');
      const refusal = ownershipFailure(owned);
      if (refusal) throw Error(refusal);
      if (initial) {
        owned.surface.style.setProperty('--dsw-corner-shape', 'initial');
        owned.styleObserver.takeRecords();
        owned.expectedStyle = styleAttribute(owned.surface);
        return {
          originalStyle: owned.originalStyle,
          actualStyle: owned.expectedStyle,
        };
      }
      return restoreSurfaceStyle(owned);
    },
    restore() {
      if (!owned) return { allocated: false, restored: true };
      const state = owned;
      const refusal = ownershipFailure(state, true);
      if (refusal) {
        state.styleObserver.disconnect();
        return {
          allocated: true,
          restored: false,
          refusal,
          originalStyle: state.originalStyle,
          actualStyle: styleAttribute(state.surface),
          externalStyleChanges: state.externalStyleChanges,
        };
      }
      try {
        const inline = restoreSurfaceStyle(state);
        const { wrapper, app, parent, next, surface } = state;
        if (app.parentNode === wrapper) parent.insertBefore(app, wrapper);
        wrapper.remove();
        const restored =
          app.parentNode === parent &&
          app.nextSibling === next &&
          !wrapper.isConnected &&
          sameStyle(styleAttribute(surface), state.originalStyle);
        if (restored) owned = undefined;
        return { allocated: true, restored, ...inline };
      } finally {
        state.styleObserver.disconnect();
      }
    },
  };
}

export type PanelsCausalSnapshot = ReturnType<
  ReturnType<typeof createPanelsCausalDom>['snapshot']
>;
declare global {
  interface Window {
    __allricePanelsCausalDom?: ReturnType<typeof createPanelsCausalDom>;
    __allricePanelsCausalDomFactory?: typeof createPanelsCausalDom;
  }
}
