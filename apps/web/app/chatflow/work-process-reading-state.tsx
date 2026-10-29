'use client';

import {
  Component,
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';

type Choice = boolean | string | null | undefined;
type Choices = Map<string, Choice>;
const ReadingContext = createContext<{
  scope: string[];
  values: Choices;
  setValues: Dispatch<SetStateAction<Choices>>;
} | null>(null);

export function WorkProcessDisclosureScope({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const context = useContext(ReadingContext);
  return (
    <ReadingContext.Provider
      value={context && { ...context, scope: [...context.scope, id] }}
    >
      {children}
    </ReadingContext.Provider>
  );
}

/** Manual choices live only in this mounted WorkProcess and Run. */
export function useProcessDisclosure<T extends Choice>(
  key: string | string[],
  initial: T,
) {
  const context = useContext(ReadingContext);
  const local = useState(initial);
  const keys = (Array.isArray(key) ? key : [key]).map((id) =>
    JSON.stringify([...(context?.scope ?? []), id]),
  );
  const current = (values: Choices) => {
    const id = keys.find((id) => values.get(id) === true) ?? keys[0]!;
    return values.has(id) ? (values.get(id) as T) : initial;
  };
  const value = context ? current(context.values) : local[0];
  const setValue = (next: SetStateAction<T>, missingOnly = false) => {
    if (!context) return local[1](next);
    context.setValues((old) => {
      const values = new Map(old);
      const selected = typeof next === 'function' ? next(current(old)) : next;
      for (const id of keys)
        if (!missingOnly || !values.has(id)) values.set(id, selected);
      return values;
    });
  };
  useLayoutEffect(() => {
    if (
      Array.isArray(key) &&
      context &&
      value === true &&
      keys.some((id) => !context.values.has(id))
    )
      setValue(value, true);
  });
  return [value, setValue] as const;
}

const inView = (node: HTMLElement) =>
  node.getBoundingClientRect().bottom > 0 &&
  node.getBoundingClientRect().top < innerHeight;
const visible = (node: HTMLElement) => node.getClientRects().length > 0;
function keyOf(node: HTMLElement, attribute: string) {
  const operation = node.closest<HTMLElement>('[data-process-operation]');
  return JSON.stringify([
    operation?.dataset.processOperation,
    node.closest<HTMLElement>('[data-process-region]')?.dataset.processRegion,
    node.getAttribute(attribute),
  ]);
}
function locate(root: HTMLElement, attribute: string, key: string | null) {
  const matches = [
    ...root.querySelectorAll<HTMLElement>(`[${attribute}]`),
  ].filter((node) => keyOf(node, attribute) === key && visible(node));
  return matches.length === 1 ? matches[0] : undefined;
}
function textPoint(node: Node, offset: number) {
  const block = (
    node instanceof Element ? node : node.parentElement
  )?.closest<HTMLElement>('[data-process-content]');
  if (!block) return;
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return {
    block,
    key: keyOf(block, 'data-process-content'),
    inView: inView(block),
    text: block.textContent,
    offset: range.toString().length,
  };
}
function restoredPoint(
  root: HTMLElement,
  point: NonNullable<ReturnType<typeof textPoint>>,
) {
  const block = locate(root, 'data-process-content', point.key);
  if (!block || block.textContent !== point.text) return;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = point.offset;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (offset <= text.textContent!.length)
      return { block, node: text, offset };
    offset -= text.textContent!.length;
  }
}

function takeReadingSnapshot(root: HTMLElement) {
  const active = document.activeElement;
  const inside =
    active instanceof HTMLElement && root.contains(active) ? active : null;
  const marker = inside?.matches('[data-process-control]')
    ? inside
    : (inside?.querySelector<HTMLElement>('[data-process-control]') ??
      inside?.closest<HTMLElement>('[data-process-control]'));
  const selection = document.getSelection();
  const anchor =
    selection?.anchorNode && root.contains(selection.anchorNode)
      ? textPoint(selection.anchorNode, selection.anchorOffset)
      : undefined;
  const focus =
    selection?.focusNode && root.contains(selection.focusNode)
      ? textPoint(selection.focusNode, selection.focusOffset)
      : undefined;
  const scroll = [
    ...root.querySelectorAll<HTMLElement>('[data-process-content]'),
  ]
    .filter((node) => visible(node) && (node.scrollTop || node.scrollLeft))
    .map((node) => ({
      node,
      key: keyOf(node, 'data-process-content'),
      text: node.textContent,
      top: node.scrollTop,
      left: node.scrollLeft,
      inView: inView(node),
    }));
  return {
    active,
    control: marker ? keyOf(marker, 'data-process-control') : null,
    content: inside && textPoint(inside, 0),
    inView: !!inside && inView(inside),
    scroll,
    selection:
      selection && !selection.isCollapsed && anchor && focus
        ? { anchor, focus, text: selection.toString() }
        : undefined,
  };
}

/** One synchronous React commit, never an event cache or an async restore. */
export class WorkProcessReadingState extends Component<
  { root: RefObject<HTMLElement | null>; children: ReactNode },
  { values: Choices },
  ReturnType<typeof takeReadingSnapshot>
> {
  override state = { values: new Map<string, Choice>() };
  override getSnapshotBeforeUpdate() {
    return takeReadingSnapshot(this.props.root.current!);
  }
  override componentDidUpdate(
    _props: unknown,
    _state: unknown,
    saved: ReturnType<typeof takeReadingSnapshot>,
  ) {
    const root = this.props.root.current!;
    const untouchedFocus =
      (document.activeElement === document.body ||
        document.activeElement === saved.active) &&
      (saved.active === document.body || !!(saved.control ?? saved.content));
    let reading: HTMLElement | undefined;
    for (const item of saved.scroll) {
      if (item.node.isConnected) continue;
      const target = locate(root, 'data-process-content', item.key);
      if (!target || target.textContent !== item.text) continue;
      target.scrollTop = item.top;
      target.scrollLeft = item.left;
      if (item.inView) reading = target;
    }
    if (untouchedFocus && !saved.active?.isConnected) {
      const marker =
        locate(root, 'data-process-content', saved.content?.key ?? null) ??
        locate(root, 'data-process-control', saved.control);
      const target =
        marker?.closest<HTMLElement>('[data-disclosure-row]') ?? marker;
      if (target && !target.matches(':disabled,[aria-disabled="true"]')) {
        target.focus({ preventScroll: true });
        if (saved.inView) reading ??= target;
      }
    }
    const selection = document.getSelection();
    if (
      untouchedFocus &&
      saved.selection &&
      selection &&
      (!saved.selection.anchor.block.isConnected ||
        !saved.selection.focus.block.isConnected)
    ) {
      const anchor = restoredPoint(root, saved.selection.anchor);
      const focus = restoredPoint(root, saved.selection.focus);
      if (anchor && focus) {
        selection.setBaseAndExtent(
          anchor.node,
          anchor.offset,
          focus.node,
          focus.offset,
        );
        if (selection.toString() !== saved.selection.text)
          selection.removeAllRanges();
        else if (saved.selection.focus.inView) reading = focus.block;
      }
    }
    if (untouchedFocus)
      reading?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
  }
  override render() {
    return (
      <ReadingContext.Provider
        value={{
          scope: [],
          values: this.state.values,
          setValues: (next) =>
            this.setState((state) => ({
              values: typeof next === 'function' ? next(state.values) : next,
            })),
        }}
      >
        {this.props.children}
      </ReadingContext.Provider>
    );
  }
}
