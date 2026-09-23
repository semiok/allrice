import { createHash } from 'node:crypto';

import type { HarnessEvent } from '@allrice/contracts';

export class AgentLoopGuardError extends Error {
  constructor(
    public readonly code:
      | 'AGENT_EVENT_LIMIT_EXCEEDED'
      | 'AGENT_TOOL_LOOP_DETECTED'
      | 'AGENT_RUNTIME_LIMIT_EXCEEDED',
  ) {
    super(code);
  }
}

export class AgentLoopGuard {
  private events = 0;
  private toolCalls = 0;
  private readonly signatures = new Map<string, number>();
  private readonly startedAt = Date.now();
  private callsObserved = false;
  private windowStart = Date.now();
  observeCallsOnly() {
    this.callsObserved = true;
  }

  constructor(
    private readonly limits: {
      maxEvents: number;
      maxToolCalls: number;
      maxIdenticalToolCalls: number;
      maxRuntimeMs: number;
    } = {
      maxEvents: 10_000,
      maxToolCalls: 80,
      maxIdenticalToolCalls: 4,
      maxRuntimeMs: 3_600_000,
    },
    private readonly clock: 'wall' | 'durable' = 'wall',
  ) {}

  observe(event: HarnessEvent, now = Date.now()) {
    // Protect event throughput, not the accumulated lifetime of a healthy task.
    if (this.callsObserved && now - this.windowStart >= 60000) {
      this.events = 0;
      this.windowStart = now;
    }
    this.events += 1;
    if (this.events > this.limits.maxEvents) {
      throw new AgentLoopGuardError('AGENT_EVENT_LIMIT_EXCEEDED');
    }
    if (
      this.clock === 'wall' &&
      now - this.startedAt > this.limits.maxRuntimeMs
    ) {
      throw new AgentLoopGuardError('AGENT_RUNTIME_LIMIT_EXCEEDED');
    }
    if (event.type !== 'tool.started') return;
    this.toolCalls += 1;
    if (this.callsObserved) return;
    if (this.toolCalls > this.limits.maxToolCalls) {
      throw new AgentLoopGuardError('AGENT_TOOL_LOOP_DETECTED');
    }
    const signature = createHash('sha256')
      .update(event.name)
      .update('\0')
      .update(JSON.stringify(event.sourcePayload ?? {}))
      .digest('hex');
    const count = (this.signatures.get(signature) ?? 0) + 1;
    this.signatures.set(signature, count);
    if (count > this.limits.maxIdenticalToolCalls) {
      throw new AgentLoopGuardError('AGENT_TOOL_LOOP_DETECTED');
    }
  }
}
