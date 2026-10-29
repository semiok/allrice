'use client';

import {
  Component,
  createContext,
  useContext,
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
  return context ? (
    <ReadingContext.Provider
      value={{ ...context, scope: [...context.scope, id] }}
    >
      {children}
    </ReadingContext.Provider>
  ) : (
    children
  );
}

/** Manual choices live only in this mounted WorkProcess and Run. */
export function useProcessDisclosure<T extends Choice>(
  key: string,
  initial: T,
) {
  const context = useContext(ReadingContext);
  const local = useState(initial);
  if (!context) return local;
  const id = JSON.stringify([...context.scope, key]);
  const value = context.values.has(id)
    ? (context.values.get(id) as T)
    : initial;
  const setValue: Dispatch<SetStateAction<T>> = (next) =>
    context.setValues((old) => {
      const values = new Map(old);
      const current = old.has(id) ? (old.get(id) as T) : initial;
      values.set(id, typeof next === 'function' ? next(current) : next);
      return values;
    });
  return [value, setValue] as const;
}

/** A native split inherits the choice for its remaining members. */
export function useWorkGroupDisclosure(ids: string[]) {
  const context = useContext(ReadingContext);
  const local = useState(false);
  if (!context) return local;
  const keys = ids.map((id) => JSON.stringify([...context.scope, 'group', id]));
  return [
    keys.some((key) => context.values.get(key) === true),
    (next: boolean) =>
      context.setValues((old) => {
        const values = new Map(old);
        for (const key of keys) values.set(key, next);
        return values;
      }),
  ] as const;
}

const visible = (node: HTMLElement) => node.getClientRects().length > 0;
function keyOf(node: HTMLElement, attribute: string) {
  const operation = node.closest<HTMLElement>('[data-process-operation]');
  return (
    operation &&
    JSON.stringify([
      operation.dataset.processOperation,
      node.closest<HTMLElement>('[data-process-region]')?.dataset.processRegion,
      node.getAttribute(attribute),
    ])
  );
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
  const marker =
    active instanceof HTMLElement && root.contains(active)
      ? (active.closest<HTMLElement>('[data-process-control]') ??
        active.querySelector<HTMLElement>('[data-process-control]'))
      : null;
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
      inView:
        node.getBoundingClientRect().bottom > 0 &&
        node.getBoundingClientRect().top < innerHeight,
    }));
  return {
    active,
    selectedText: selection?.toString(),
    control: marker && keyOf(marker, 'data-process-control'),
    scroll,
    selection:
      selection && !selection.isCollapsed && anchor && focus
        ? { anchor, focus }
        : undefined,
  };
}
type Snapshot = ReturnType<typeof takeReadingSnapshot> | null;

/** One synchronous React commit, never an event cache or an async restore. */
export class WorkProcessReadingState extends Component<
  { root: RefObject<HTMLElement | null>; children: ReactNode },
  { values: Choices },
  Snapshot
> {
  override state = { values: new Map<string, Choice>() };
  override getSnapshotBeforeUpdate() {
    return this.props.root.current
      ? takeReadingSnapshot(this.props.root.current)
      : null;
  }
  override componentDidUpdate(
    _props: unknown,
    _state: unknown,
    saved: Snapshot,
  ) {
    const root = this.props.root.current;
    if (!root || !saved) return;
    const untouchedFocus =
      document.activeElement === document.body ||
      document.activeElement === saved.active;
    let reading: HTMLElement | undefined;
    for (const item of saved.scroll) {
      if (item.node.isConnected) continue;
      const target = locate(root, 'data-process-content', item.key);
      if (!target || target.textContent !== item.text) continue;
      target.scrollTop = item.top;
      target.scrollLeft = item.left;
      if (item.inView) reading = target;
    }
    let focused: HTMLElement | undefined;
    if (untouchedFocus && saved.control && !saved.active?.isConnected) {
      const marker = locate(root, 'data-process-control', saved.control);
      const target =
        marker?.closest<HTMLElement>('[data-disclosure-row]') ?? marker;
      if (target && !target.matches(':disabled,[aria-disabled="true"]')) {
        target.focus({ preventScroll: true });
        focused = target;
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
        if (selection.toString() !== saved.selectedText)
          selection.removeAllRanges();
        else reading = focus.block;
      }
    }
    if (untouchedFocus)
      (reading ?? focused)?.scrollIntoView({
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
