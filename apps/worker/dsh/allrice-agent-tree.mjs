/** Native-path snapshot for fast rejection, never permission to detach/repair.
 * An idle child may still be flushing/disposing before settlement reaches the
 * root inbox; in-flight creation is also invisible here. Admission needs DSH's
 * session/wait or subagents.waitForChildren(root), then state/input checks and
 * a recheck after awaits. Only live local Agents are observed, not external
 * activations. The legacy assistant bridge is outside this contract. */
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

/** Fast rejection for final-delivery repair on the native path. Both predicates
 * can be true while an idle child's settlement has not reached the root inbox.
 * Repair needs session/wait before this recheck; question detach instead needs
 * waitForChildren(root) before its flush/rechecks, and may retain root inbox.
 * Parked idle descendants deliberately do not prevent either observation. */
export function treeQuiescent(root) {
  return (
    noRunningDescendants(root) &&
    root.inbox.nextStep.length === 0 &&
    root.inbox.nextTurn.length === 0
  );
}
