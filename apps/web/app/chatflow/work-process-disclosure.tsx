'use client';

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
  type FocusEvent,
} from 'react';

type Choice = string | boolean | null | undefined;
type Choices = Map<string, Choice>;
const DisclosureContext = createContext<{
  scope: string[];
  values: Choices;
  setValues: Dispatch<SetStateAction<Choices>>;
} | null>(null);
export const WorkProcessDisclosureProvider = DisclosureContext.Provider;

/** Only this mounted process owns these manual UI choices, like native useDisclosure. */
export function useWorkProcessDisclosures(runId: string) {
  const [values, setValues] = useState<Choices>(() => new Map());
  const ref = useRef<HTMLElement>(null);
  const focused = useRef<{
    node: HTMLElement;
    operation: string;
    section?: string;
    tag: string;
    name: string;
    control: 'operation' | 'call' | 'named';
  }>(undefined);
  const nameOf = (node: HTMLElement) =>
    node.getAttribute('aria-label') ??
    node.getAttribute('href') ??
    node.textContent?.trim() ??
    '';
  // Native regrouping may replace a call's parent. Restore the same control,
  // only when its old node disappeared and the user has not focused elsewhere.
  useLayoutEffect(() => {
    const saved = focused.current;
    if (
      !saved ||
      saved.node.isConnected ||
      document.activeElement !== document.body
    )
      return;
    const operation = document.getElementById(saved.operation);
    if (!operation || !ref.current?.contains(operation)) return;
    const target =
      saved.control === 'operation'
        ? operation
        : saved.control === 'call'
          ? operation.querySelector<HTMLElement>('[data-disclosure-row]')
          : [
              ...operation.querySelectorAll<HTMLElement>(
                'button,a[href],[role="button"],input,select,textarea,[tabindex]',
              ),
            ].find(
              (node) =>
                node.tagName === saved.tag &&
                nameOf(node) === saved.name &&
                node.closest<HTMLElement>('[data-operation-section]')?.dataset
                  .operationSection === saved.section,
            );
    if (
      target &&
      !target.matches(':disabled') &&
      target.getClientRects().length
    ) {
      if (saved.control === 'operation') target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    }
  });
  return {
    value: { scope: [runId], values, setValues },
    focusProps: {
      ref,
      onFocusCapture: (event: FocusEvent<HTMLElement>) => {
        const node = event.target as HTMLElement;
        const operation = node.closest<HTMLElement>('[data-work-call][id]');
        focused.current = operation
          ? {
              node,
              operation: operation.id,
              tag: node.tagName,
              name: nameOf(node),
              control:
                node === operation
                  ? 'operation'
                  : node === operation.querySelector('[data-disclosure-row]')
                    ? 'call'
                    : 'named',
              section: node.closest<HTMLElement>('[data-operation-section]')
                ?.dataset.operationSection,
            }
          : undefined;
      },
      onBlurCapture: () => {
        focused.current = undefined;
      },
    },
  };
}

export function WorkProcessDisclosureScope({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const parent = useContext(DisclosureContext);
  return parent ? (
    <DisclosureContext.Provider
      value={{ ...parent, scope: [...parent.scope, id] }}
    >
      {children}
    </DisclosureContext.Provider>
  ) : (
    children
  );
}

export function useProcessDisclosure<T extends Choice>(
  key: string,
  initial: T,
) {
  const context = useContext(DisclosureContext);
  const local = useState(initial);
  if (!context) return local;
  const id = JSON.stringify([...context.scope, key]);
  const value = context.values.has(id)
    ? (context.values.get(id) as T)
    : initial;
  const setValue: Dispatch<SetStateAction<T>> = (next) =>
    context.setValues((previous) => {
      const values = new Map(previous);
      const current = previous.has(id) ? (previous.get(id) as T) : initial;
      values.set(id, typeof next === 'function' ? next(current) : next);
      return values;
    });
  return [value, setValue] as const;
}

/** A split inherits the reader's choice for the steps it still contains. */
export function useWorkGroupDisclosure(ids: string[]) {
  const context = useContext(DisclosureContext);
  const local = useState(false);
  if (!context) return local;
  const keys = ids.map((id) => JSON.stringify([...context.scope, 'group', id]));
  const open = keys.some((key) => context.values.get(key) === true);
  return [
    open,
    (next: boolean) =>
      context.setValues((previous) => {
        const values = new Map(previous);
        for (const key of keys) values.set(key, next);
        return values;
      }),
  ] as const;
}
