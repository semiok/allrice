import { describe, it, expect } from 'vitest';
import type { BrowserWorkspaceView } from '@allrice/database';
import {
  browserControlAvailability as controls,
  browserWorkspacePollingRequired,
} from './browser-control-state';
const view = (state = 'human', extra: Partial<BrowserWorkspaceView> = {}) =>
  ({
    available: true,
    state,
    fence: 2,
    acknowledgedFence: 2,
    observation: { expiresAt: new Date(2000).toISOString() },
    ...extra,
  }) as BrowserWorkspaceView;
describe('browser input availability is separate from observation refresh', () => {
  it('continues polling after the assistant message ends until physical close settles', () => {
    expect(
      browserWorkspacePollingRequired(false, [view('takeover_pending')]),
    ).toBe(true);
    expect(
      browserWorkspacePollingRequired(false, [view('close_pending')]),
    ).toBe(true);
    expect(browserWorkspacePollingRequired(false, [view('closed')])).toBe(
      false,
    );
    expect(browserWorkspacePollingRequired(false, [view('unknown')])).toBe(
      false,
    );
  });
  it('expired observation forbids input/resume but permits a fresh read', () => {
    expect(controls(view(), 3000)).toEqual({
      human: false,
      observe: true,
      resume: false,
      takeover: false,
    });
  });
  it('keeps a prior observation disabled until the submitted action settles and a new capture arrives', () => {
    const operation = {
      command: { actor: 'human', fence: 2, observationId: 'before' },
      snapshot: { status: 'running' },
      result: null,
      approval: null,
    };
    const current = view('human', {
      observation: { id: 'before', expiresAt: new Date(2000).toISOString() },
      operations: [operation],
    } as unknown as Partial<BrowserWorkspaceView>);
    expect(controls(current, 1000)).toMatchObject({
      human: false,
      observe: false,
    });
    operation.snapshot.status = 'succeeded';
    Object.assign(operation, { result: { completed: true } });
    expect(controls(current, 1000)).toMatchObject({
      human: false,
      observe: false,
    });
    current.observation!.id = 'after';
    expect(controls(current, 1000)).toMatchObject({
      human: true,
      observe: true,
    });
  });
  it('does not let rejected or stale-fence queue entries lock human controls', () => {
    const current = view('human', {
      operations: [
        {
          command: { actor: 'human', fence: 2 },
          snapshot: { status: 'waiting_user' },
          approval: {
            response: { decision: 'rejected' },
            request: { expiresAt: new Date(2000).toISOString() },
          },
        },
        {
          command: { actor: 'agent', fence: 1 },
          snapshot: { status: 'running' },
        },
      ],
    } as unknown as Partial<BrowserWorkspaceView>);
    expect(controls(current, 1000)).toMatchObject({
      human: true,
      observe: true,
    });
  });
  it('pending physical takeover never enables human input', () => {
    expect(
      controls(view('takeover_pending', { acknowledgedFence: 1 }), 1000),
    ).toEqual({ human: false, observe: false, resume: false, takeover: false });
  });
  it('acknowledged human may use fresh observation; paused may resume or take over', () => {
    expect(controls(view(), 1000)).toMatchObject({
      human: true,
      observe: true,
      resume: true,
    });
    expect(controls(view('paused'), 1000)).toEqual({
      human: false,
      observe: false,
      resume: true,
      takeover: true,
    });
  });
  it.each(['unknown', 'closed', 'close_pending'])(
    'does not enable input in %s',
    (state) => {
      expect(controls(view(state, { available: false }), 1000)).toEqual({
        human: false,
        observe: false,
        resume: false,
        takeover: false,
      });
    },
  );
});
