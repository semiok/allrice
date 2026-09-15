import { describe, expect, it } from 'vitest';
import { createSessionActions } from './session-actions';
import { createSessionSelection } from './session-selection';

describe('P26 scoped UI action ownership (does not cancel server work)', () => {
  it('deduplicates the same composer action synchronously, before React renders busy', () => {
    const selection = createSessionSelection();
    selection.select('A');
    const actions = createSessionActions(selection.capture);
    const first = actions.begin('composer')!;
    expect(actions.begin('composer')).toBeNull();
    expect(first.finish()).toBe(true);
    expect(actions.pending('composer')).toBe(false);
    expect(actions.begin('composer')).not.toBeNull();
  });
  it('late A success/failure/finally cannot own a new B composer', () => {
    const selection = createSessionSelection();
    selection.select('A');
    const actions = createSessionActions(selection.capture);
    const first = actions.begin('composer')!;
    selection.select('B');
    expect(first.current()).toBe(false);
    expect(actions.pending('composer')).toBe(false);
    const second = actions.begin('composer')!;
    expect(first.finish()).toBe(false);
    expect(second.current()).toBe(true);
    expect(actions.pending('composer')).toBe(true);
  });
  it('returning A→B→A cannot resurrect an earlier send or answer', () => {
    const selection = createSessionSelection();
    selection.select('A');
    const actions = createSessionActions(selection.capture);
    const send = actions.begin('composer')!;
    const answer = actions.begin('question')!;
    selection.select('B');
    selection.select('A');
    expect(send.current()).toBe(false);
    expect(answer.current()).toBe(false);
    expect(send.finish()).toBe(false);
    expect(answer.finish()).toBe(false);
  });
  it('adopts only our null→new Session transition without losing busy ownership', () => {
    const selection = createSessionSelection();
    const actions = createSessionActions(selection.capture);
    const send = actions.begin('composer')!;
    selection.select('created');
    expect(send.adoptCreatedSession('created')).toBe(true);
    expect(actions.pending('composer')).toBe(true);
    expect(send.adoptCreatedSession('created')).toBe(false);
    expect(send.finish()).toBe(true);
  });
  it('does not adopt a created Session after another selection or a fresh New click', () => {
    for (const navigate of [
      (selection: ReturnType<typeof createSessionSelection>) => {
        selection.select('B');
        selection.select(null);
      },
      (selection: ReturnType<typeof createSessionSelection>) =>
        selection.invalidate(),
    ]) {
      const selection = createSessionSelection();
      const actions = createSessionActions(selection.capture);
      const send = actions.begin('composer')!;
      navigate(selection);
      selection.select('created');
      expect(send.adoptCreatedSession('created')).toBe(false);
      expect(send.finish()).toBe(false);
    }
  });
  it('unmount invalidates pending UI work without invoking a cancellation transport', () => {
    const selection = createSessionSelection();
    const actions = createSessionActions(selection.capture);
    const send = actions.begin('composer')!;
    selection.invalidate();
    expect(send.current()).toBe(false);
    expect(send.finish()).toBe(false);
  });
});
