import { describe, it, expect } from 'vitest';
import {
  initialProgressState,
  observeProgress,
  type ProgressFact,
} from './task-progress-policy.ts';
const fact: ProgressFact = {
  name: 'web.fetch',
  argumentsDigest: 'a',
  resultDigest: 'b',
  outcome: 'error',
};
describe('MET-153 deterministic bounded no-progress policy', () => {
  it('pauses three exact failures, not mere repeated invocation', () => {
    let s = initialProgressState();
    for (let i = 0; i < 3; i++) s = observeProgress(s, fact);
    expect(s.reason).toBe('repeated_failure');
    s = initialProgressState();
    for (let i = 0; i < 100; i++)
      s = observeProgress(s, {
        ...fact,
        resultDigest: String(i),
        outcome: 'success',
      });
    expect(s.reason).toBeNull();
    expect(s.history).toHaveLength(32);
  });
  it('does not reset failure history for varied args, new children, logging or polling', () => {
    let s = initialProgressState();
    for (let i = 0; i < 8; i++) {
      s = observeProgress(s, { ...fact, argumentsDigest: String(i) });
      s = observeProgress(s, {
        ...fact,
        name: 'assistant.delegate',
        outcome: 'control',
      });
    }
    expect(s.reason).toBe('repeated_failure');
  });
  it('allows expected polling, bounded retries and control events without an artificial count cap', () => {
    let s = initialProgressState();
    for (let i = 0; i < 300; i++)
      s = observeProgress(s, {
        ...fact,
        outcome: ['poll', 'retry', 'control'][i % 3] as ProgressFact['outcome'],
      });
    expect(s).toEqual(initialProgressState());
  });
  it('asks about repeated output or oscillation, preserving its bounded evidence', () => {
    let s = initialProgressState();
    for (let i = 0; i < 12; i++)
      s = observeProgress(s, {
        ...fact,
        outcome: 'success',
        resultDigest: String(i % 2),
        argumentsDigest: String(i),
      });
    expect(s.reason).toBe('repeated_no_progress');
    expect(observeProgress(s, { ...fact, resultDigest: 'new' })).toBe(s);
  });
});
