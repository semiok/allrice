import { describe, expect, it } from 'vitest';
import type { ProjectLockPlatformFacts } from '@allrice/database';
import { projectLockPlatformMessage } from './project-lock-message.js';

const facts = (
  over: Partial<ProjectLockPlatformFacts>,
): ProjectLockPlatformFacts => ({
  lockArchitectures: ['arm64'],
  bridgeArchitectures: ['amd64'],
  serverArchitecture: 'arm64',
  userLocalOnly: false,
  localInputs: false,
  toolLocal: false,
  cloudOnly: false,
  cloudUsable: true,
  currentBridgeArchitectures: ['amd64'],
  ...over,
});

describe('project lock platform message', () => {
  it('offers a resolve for the Intel Bridge when local files keep it local', () => {
    const text = projectLockPlatformMessage(facts({ localInputs: true }));
    expect(text).toMatch(/architecture: amd64.*在本机执行/);
    expect(text).not.toMatch(/云端执行$/);
  });
  it('never offers a resolve when the user keeps the task local', () => {
    const text = projectLockPlatformMessage(facts({ userLocalOnly: true }));
    expect(text).not.toMatch(/用 resolve/);
    expect(text).toMatch(/本次任务不允许/);
  });
  it('does not present a new lock as enough for a Bridge that needs upgrading', () => {
    const text = projectLockPlatformMessage(
      facts({ localInputs: true, currentBridgeArchitectures: [] }),
    );
    expect(text).toMatch(/先升级 Bridge/);
    expect(text).not.toMatch(/architecture: amd64/);
  });
  it('still offers the Bridges that support the request when another needs upgrading', () => {
    const text = projectLockPlatformMessage(
      facts({
        localInputs: true,
        bridgeArchitectures: ['amd64', 'amd64'],
        currentBridgeArchitectures: ['amd64'],
      }),
    );
    expect(text).toMatch(/architecture: amd64.*在本机执行/);
    expect(text).not.toMatch(/先升级 Bridge/);
  });
  it('names every obstacle together', () => {
    const text = projectLockPlatformMessage(
      facts({ localInputs: true, cloudUsable: false }),
    );
    expect(text).toMatch(/本机文件.*云端执行没有开启/);
    expect(text).not.toMatch(/用 resolve/);
  });
  it('offers the cloud only where the current lock fits it', () => {
    expect(
      projectLockPlatformMessage(
        facts({ toolLocal: true, lockArchitectures: ['arm64'] }),
      ),
    ).toMatch(/去掉 location: local/);
    const stale = projectLockPlatformMessage(
      facts({ lockArchitectures: ['amd64'], bridgeArchitectures: [] }),
    );
    expect(stale).toMatch(/云端是 Apple 芯片.*按默认架构/);
    expect(
      projectLockPlatformMessage(
        facts({ lockArchitectures: [], cloudUsable: false }),
      ),
    ).not.toMatch(/云端执行$|让它在云端执行/);
  });
});
