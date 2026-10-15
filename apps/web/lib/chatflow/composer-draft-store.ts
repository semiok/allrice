/** Per-workbench draft ownership. Only the composer subscribes to the text. */
export function createComposerDraftStore() {
  let text = '';
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => text,
    hasDraft: () => Boolean(text.trim()),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: string | ((current: string) => string)) {
      const value = typeof next === 'function' ? next(text) : next;
      if (value === text) return;
      text = value;
      listeners.forEach((listener) => listener());
    },
  };
}
export type ComposerDraftStore = ReturnType<typeof createComposerDraftStore>;
