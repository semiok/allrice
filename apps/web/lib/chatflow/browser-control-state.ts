import type { BrowserWorkspaceView } from '@allrice/database';
export function browserWorkspacePollingRequired(
  runActive: boolean,
  workspaces: BrowserWorkspaceView[],
) {
  return (
    runActive ||
    workspaces.some((w) => !['closed', 'unknown'].includes(w.state))
  );
}
export function browserControlAvailability(
  w: BrowserWorkspaceView,
  now = Date.now(),
) {
  const ack = w.available && w.fence === w.acknowledgedFence;
  const fresh = !!w.observation && Date.parse(w.observation.expiresAt) > now;
  const settling = (w.operations ?? []).some((op) => {
    if (op.command.fence !== w.fence || op.command.actor !== w.state)
      return false;
    const unavailable =
      op.approval?.response?.decision === 'rejected' ||
      !!op.approval?.revokedAt ||
      (!!op.approval && Date.parse(op.approval.request.expiresAt) <= now);
    return (
      (!unavailable &&
        ['ready', 'waiting_user', 'dispatched', 'running'].includes(
          op.snapshot.status,
        )) ||
      (op.snapshot.status === 'succeeded' &&
        !!op.result &&
        w.observation?.id === op.command.observationId)
    );
  });
  return {
    human: ack && w.state === 'human' && fresh && !settling,
    observe: ack && w.state === 'human' && !settling,
    resume: ack && ['human', 'paused'].includes(w.state) && fresh,
    takeover: w.available && ['agent', 'paused'].includes(w.state),
  };
}
