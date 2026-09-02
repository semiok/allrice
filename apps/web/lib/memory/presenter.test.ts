import { describe, expect, it } from 'vitest';

import {
  memoryClassLabel,
  memoryLifecycleLabel,
  memorySourceLabel,
  resolveMemoryLifecycle,
} from './presenter';

describe('memory presenter', () => {
  it('keeps derived and external information as candidates', () => {
    expect(
      resolveMemoryLifecycle({
        trust: 'derived',
        sourceType: 'message',
      }),
    ).toBe('candidate');
    expect(
      memoryLifecycleLabel({
        trust: 'untrusted_external',
        sourceType: 'connector',
      }),
    ).toBe('待你确认');
  });

  it('presents confirmed information as durable memory', () => {
    expect(
      resolveMemoryLifecycle({
        trust: 'user_confirmed',
        sourceType: 'user',
      }),
    ).toBe('durable');
  });

  it('prefers an explicit lifecycle returned by Memory 2.0', () => {
    expect(
      resolveMemoryLifecycle({
        lifecycleState: 'candidate',
        trust: 'platform_verified',
        sourceType: 'tool',
      }),
    ).toBe('candidate');
  });

  it('uses tenant-readable provenance labels', () => {
    expect(
      memorySourceLabel({
        trust: 'derived',
        sourceType: 'file',
      }),
    ).toBe('来自文件');
    expect(memoryClassLabel('user_preference')).toBe('用户偏好');
    expect(
      memorySourceLabel({
        trust: 'derived',
        sourceType: 'checkpoint',
      }),
    ).toBe('来自上下文压缩');
  });
});
