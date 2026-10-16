/** Public Bridge control includes a <=4s backend risk lookup plus WAN/TLS.
 * The cycle also reads trusted Docker metrics (0.5 + 1.5 + 0.5s).
 * A separate PID1 lease bounds a dead controller; none of these extend the
 * authority's execution deadline. See docs/operations/bridge-control-timeouts.md. */
export const localExecutionRequestTimeoutMs = 8_000;
export const localExecutionCycleTimeoutMs = 11_000;
