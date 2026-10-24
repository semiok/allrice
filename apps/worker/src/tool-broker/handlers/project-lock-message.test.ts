import { describe, expect, it } from 'vitest';
import { projectLockPlatformMessage } from './project-lock-message.js';

const message = (
  bridgeArchitectures: string[],
  cloudBlocked: 'local_request' | 'local_inputs' | 'disabled' | null,
  lockArchitectures = ['amd64'],
  serverArchitecture = 'arm64',
) =>
  projectLockPlatformMessage({
    lockArchitectures,
    bridgeArchitectures,
    serverArchitecture,
    cloudBlocked,
  });

describe('project lock platform message', () => {
  it('asks for a new resolve when the cloud may run it but is the other CPU', () => {
    expect(message([], null)).toMatch(/云端是 Apple 芯片.*resolve 重新解析/);
  });
  it('points a stale lock on a Bridge of the server CPU to a new resolve', () => {
    expect(message(['arm64'], 'local_inputs')).toMatch(
      /旧锁.*只上传依赖声明.*在本机执行/,
    );
    expect(message(['arm64'], 'local_request')).toMatch(
      /旧锁.*本次不能重新解析/,
    );
    expect(message(['arm64'], 'disabled')).toMatch(/旧锁.*云端执行没有开启/);
  });
  it('does not promise a resolve that cannot produce this Bridge CPU', () => {
    for (const blocked of [
      'local_request',
      'local_inputs',
      'disabled',
    ] as const) {
      const text = message(['amd64'], blocked, ['arm64'], 'arm64');
      expect(text).toMatch(/还不能为本机生成可用的锁/);
      expect(text).not.toMatch(/resolve 重新解析/);
    }
    expect(message(['amd64'], 'local_inputs', ['arm64'])).toMatch(
      /只能在本机执行/,
    );
  });
});
