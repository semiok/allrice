import type { SessionNode } from './tree';
const COLLAPSED_SESSION_LIMIT = 5;
export function collapsedSessionRows(sessions: readonly SessionNode[], limit = COLLAPSED_SESSION_LIMIT): {
  rows: readonly SessionNode[]
  hiddenCount: number
} {
  let idleCount = 0
  const rows = sessions.filter((session) => {
    if (session.blank || session.running || session.runningSubagentCount > 0) return true
    if (idleCount >= limit) return false
    idleCount += 1
    return true
  })
  return { rows, hiddenCount: sessions.length - rows.length }
}

