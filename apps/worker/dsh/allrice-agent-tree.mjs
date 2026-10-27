/** Synchronous observations of DSH's live ownership tree, not a completion
 * decision or an admission lock. Callers own the root's idle/question check
 * and must recheck after awaiting work (for example a persistence flush). */
export function noRunningDescendants(root) {
  const registry = root.ctx.agents;
  const remaining = new Set(registry.list().filter((agent) => agent !== root));
  const parents = [root];
  for (const parent of parents) {
    for (const agent of remaining) {
      if (!registry.isOwnedBy(agent.id, parent)) continue;
      if (agent.status === 'running') return false;
      remaining.delete(agent);
      parents.push(agent);
    }
  }
  return true;
}

/** A blocked question may detach with durable notifications still queued;
 * final-delivery repair must additionally wait for the root to consume them.
 * Parked idle descendants deliberately do not prevent either observation. */
export function treeQuiescent(root) {
  return (
    noRunningDescendants(root) &&
    root.inbox.nextStep.length === 0 &&
    root.inbox.nextTurn.length === 0
  );
}
