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
  let owned:
    | {
        wrapper: HTMLDivElement;
        app: HTMLElement;
        parent: HTMLElement;
        next: ChildNode | null;
        surface: HTMLElement;
        nonce: string;
        corner: string;
        priority: string;
      }
    | undefined;
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
      // Capture ownership before the first DOM mutation, including partial setup.
      owned = {
        wrapper,
        app,
        parent: document.body,
        next: app.nextSibling,
        surface,
        nonce,
        corner: surface.style.getPropertyValue('--dsw-corner-shape'),
        priority: surface.style.getPropertyPriority('--dsw-corner-shape'),
      };
      document.body.insertBefore(wrapper, app);
      wrapper.append(app);
    },
    transform(value: string | null) {
      if (
        !owned ||
        owned.wrapper.dataset.allriceCausalContainer !== owned.nonce
      )
        throw Error('Lost own diagnostic wrapper');
      if (value === null) owned.wrapper.style.removeProperty('transform');
      else owned.wrapper.style.transform = value;
    },
    corner(initial: boolean) {
      if (!owned || !owned.app.contains(owned.surface))
        throw Error('AllRice surface replaced');
      if (initial)
        owned.surface.style.setProperty('--dsw-corner-shape', 'initial');
      else if (owned.corner)
        owned.surface.style.setProperty(
          '--dsw-corner-shape',
          owned.corner,
          owned.priority,
        );
      else owned.surface.style.removeProperty('--dsw-corner-shape');
    },
    restore() {
      if (!owned) return { allocated: false, restored: true };
      const { wrapper, app, parent, next, surface, nonce, corner, priority } =
        owned;
      if (
        wrapper.dataset.allriceCausalContainer !== nonce ||
        !app.contains(surface)
      )
        return {
          allocated: true,
          restored: false,
          refusal: 'Wrapper or AllRice surface identity changed',
        };
      if (corner)
        surface.style.setProperty('--dsw-corner-shape', corner, priority);
      else surface.style.removeProperty('--dsw-corner-shape');
      if (
        wrapper.parentNode === parent &&
        app.parentNode === wrapper &&
        wrapper.childNodes.length === 1 &&
        wrapper.nextSibling === next
      ) {
        parent.insertBefore(app, wrapper);
        wrapper.remove();
      } else if (
        app.parentNode === parent &&
        wrapper.childNodes.length === 0 &&
        (!wrapper.parentNode || wrapper.parentNode === parent)
      ) {
        wrapper.remove(); // Safe rollback of partial attach before app was moved.
      } else
        return {
          allocated: true,
          restored: false,
          refusal:
            'Original DOM parent/order changed; refuse destructive rollback',
        };
      const restored =
        app.parentNode === parent &&
        app.nextSibling === next &&
        !wrapper.isConnected &&
        surface.style.getPropertyValue('--dsw-corner-shape') === corner &&
        surface.style.getPropertyPriority('--dsw-corner-shape') === priority;
      owned = undefined;
      return { allocated: true, restored };
    },
  };
}

export type PanelsCausalSnapshot = ReturnType<
  ReturnType<typeof createPanelsCausalDom>['snapshot']
>;
declare global {
  interface Window {
    __allricePanelsCausalDom?: ReturnType<typeof createPanelsCausalDom>;
  }
}
