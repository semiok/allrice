/** Synthetic DOM observer shared by the regression and QA capture. No animation-ready waits. */
export function installProcessAlignmentSampler() {
  Reflect.set(window, 'alignmentSamplerInstalled', {
    at: performance.now(),
    hadHeader: !!document.querySelector('[data-disclosure-row]'),
  });
  const nodes = new WeakMap<Element, number>();
  let nextId = 1;
  const identity = (node: Element) => {
    if (!nodes.has(node)) nodes.set(node, nextId++);
    return nodes.get(node)!;
  };
  const read = () => {
    const observed = {
      at: performance.now(),
      timeOrigin: performance.timeOrigin,
    };
    const marker = document
      .querySelector('[data-alignment-phase]')
      ?.getAttribute('data-alignment-phase');
    const headerNode = document.querySelector(
      'section[aria-label="工作过程"] [data-disclosure-row]',
    );
    if (!headerNode)
      return {
        ...observed,
        marker,
        visible: false,
        identity: null,
        measurement: null,
      };
    const measurement = (() => {
      const section = document.querySelector('section[aria-label="工作过程"]')!;
      const header = section.querySelector('[data-disclosure-row]')!;
      const title = header.querySelector('[class*="processTitle"]')!;
      const timing = header.querySelector('[aria-label="本轮运行时间"]');
      const arrow = header.firstElementChild!.querySelector('svg')!;
      const avatar = document.querySelector('[class*="assistantIdentity"] i')!;
      const frame = document.querySelector('[data-process-scrollport]');
      const box = header.getBoundingClientRect();
      const opacity = (node: Element) => {
        let result = 1;
        for (
          let current: Element | null = node;
          current;
          current = current.parentElement
        )
          result *= Number(getComputedStyle(current).opacity);
        return result;
      };
      const text = timing?.firstChild;
      const space = document.createRange();
      if (text) {
        space.setStart(text, 0);
        space.setEnd(text, 1);
      }
      return {
        top: box.top,
        height: box.height,
        gap: frame ? frame.getBoundingClientRect().top - box.bottom : null,
        parts: !!frame && !section.contains(frame),
        title: title.textContent,
        timing: timing?.textContent ?? null,
        space: text ? space.getBoundingClientRect().width : null,
        color: [arrow, title, ...(timing ? [timing] : [])].map(
          (node) => getComputedStyle(node).color,
        ),
        avatarColor: getComputedStyle(avatar).backgroundColor,
        opacity: [arrow, title, ...(timing ? [timing] : []), avatar].map(
          opacity,
        ),
        clocks: [header, avatar].map((node) =>
          node.getAnimations().map((animation) => ({
            start: animation.startTime,
            pending: animation.pending,
            current: animation.currentTime,
            duration: animation.effect!.getTiming().duration,
            easing: getComputedStyle(node).animationTimingFunction,
          })),
        ),
      };
    })();
    return {
      ...observed,
      marker,
      visible: !!headerNode.getClientRects().length,
      identity: identity(headerNode),
      measurement,
    };
  };
  let wanted = 0,
    frames = 0,
    armed = false;
  let samples: (ReturnType<typeof read> & { source: 'commit' | 'raf' })[] = [];
  let done: (value: typeof samples) => void;
  const collect = (source: 'commit' | 'raf') => {
    if (!armed) return false;
    const sample = read();
    if (sample.marker !== String(wanted)) return false;
    samples.push({ ...sample, source });
    return true;
  };
  new MutationObserver(() => collect('commit')).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-alignment-phase'],
  });
  const tick = () => {
    if (collect('raf') && ++frames === 4) {
      armed = false;
      done([...samples]);
    } else requestAnimationFrame(tick);
  };
  const arm = (phase: number) => {
    wanted = phase;
    frames = 0;
    samples = [];
    armed = true;
    const result = new Promise<typeof samples>((resolve) => {
      done = resolve;
    });
    requestAnimationFrame(tick);
    return result;
  };
  const initial = arm(0);
  const capture = (phase: number) => {
    if (phase === 0) return initial;
    const result = arm(phase);
    window.alignPhase(phase);
    return result;
  };
  Reflect.set(window, 'alignmentCapture', capture);
  return capture;
}

declare global {
  interface Window {
    alignmentCapture: ReturnType<typeof installProcessAlignmentSampler>;
    alignmentSamplerInstalled: { at: number; hadHeader: boolean };
  }
}
