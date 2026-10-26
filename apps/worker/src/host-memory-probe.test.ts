import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readHostMemory,
  readHostMemorySync,
  systemMemoryProbe,
} from './host-memory.js';
import { createMemoryGate, memoryGateSettings } from './memory-gate.js';

const child = vi.hoisted(() => ({ async: vi.fn(), sync: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  // Match Node's execFile custom promisification (stdout + stderr).
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: child.async,
  });
  return { execFile, execFileSync: child.sync };
});

const MiB = 1024 ** 2;
const darwin = { ...systemMemoryProbe, platform: 'darwin' as const };
const normal = '1\n3664\n185712\n1821\n16384\n';
const normalBytes = (3664 + 185712 + 1821) * 16384;

beforeEach(() => {
  child.async.mockReset();
  child.sync.mockReset();
  vi.spyOn(process, 'availableMemory').mockReturnValue(120 * MiB);
});
afterEach(() => vi.restoreAllMocks());

describe('system memory adapter and failure recovery (MET-219)', () => {
  it('reads the kernel keys without a shell and bounds asynchronous and startup reads to two seconds', async () => {
    child.async.mockResolvedValue({ stdout: normal, stderr: '' });
    child.sync.mockReturnValue(normal);
    const expected = {
      source: 'memorystatus',
      pressure: 'normal',
      availableBytes: normalBytes,
    };
    await expect(readHostMemory(darwin)).resolves.toEqual(expected);
    expect(readHostMemorySync(darwin)).toEqual(expected);
    const args = [
      '-n',
      'kern.memorystatus_vm_pressure_level',
      'vm.page_free_count',
      'vm.page_pageable_external_count',
      'vm.page_purgeable_count',
      'hw.pagesize',
    ];
    expect(child.async).toHaveBeenCalledExactlyOnceWith(
      '/usr/sbin/sysctl',
      args,
      {
        encoding: 'utf8',
        timeout: 2_000,
      },
    );
    expect(child.sync).toHaveBeenCalledExactlyOnceWith(
      '/usr/sbin/sysctl',
      args,
      {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    expect(process.availableMemory).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ETIMEDOUT'])(
    'falls back for both readers on %s and keeps the byte floor',
    async (code) => {
      const error = Object.assign(Error(`sysctl ${code}`), {
        code,
        killed: code === 'ETIMEDOUT',
      });
      child.async.mockRejectedValue(error);
      child.sync.mockImplementation(() => {
        throw error;
      });
      const expected = {
        source: 'available_memory',
        pressure: null,
        availableBytes: 120 * MiB,
        error: `sysctl ${code}`,
      };
      await expect(readHostMemory(darwin)).resolves.toEqual(expected);
      expect(readHostMemorySync(darwin)).toEqual(expected);
      const gate = createMemoryGate({
        settings: memoryGateSettings({}),
        read: () => readHostMemory(darwin),
        log: vi.fn(),
      });
      await expect(gate.admission()).resolves.toMatchObject({
        claim: 'none',
        reason: 'available_below_minimum',
      });
    },
  );

  it('treats truncated sysctl output as unreadable rather than an admission signal', async () => {
    child.async.mockResolvedValue({ stdout: '1\n3664\n185712\n', stderr: '' });
    child.sync.mockReturnValue('1\n3664\n185712\n');
    const expected = {
      source: 'available_memory',
      pressure: null,
      availableBytes: 120 * MiB,
      error: expect.stringContaining('MEMORYSTATUS_UNREADABLE'),
    };
    await expect(readHostMemory(darwin)).resolves.toEqual(expected);
    expect(readHostMemorySync(darwin)).toEqual(expected);
  });

  it('on Linux forwards libuv headroom unchanged in both readers without executing sysctl', async () => {
    const linux = { ...systemMemoryProbe, platform: 'linux' as const };
    vi.mocked(process.availableMemory).mockReturnValue(384 * MiB);
    const expected = {
      source: 'available_memory',
      pressure: null,
      availableBytes: 384 * MiB,
    };
    await expect(readHostMemory(linux)).resolves.toEqual(expected);
    expect(readHostMemorySync(linux)).toEqual(expected);
    expect(process.availableMemory).toHaveBeenCalledTimes(2);
    expect(child.async).not.toHaveBeenCalled();
    expect(child.sync).not.toHaveBeenCalled();
  });

  it('recovers from an unreadable probe on the next sample without restarting the gate', async () => {
    let clock = 0;
    const log = vi.fn();
    child.async
      .mockRejectedValueOnce(Error('sysctl timed out'))
      .mockResolvedValue({ stdout: normal, stderr: '' });
    const gate = createMemoryGate({
      settings: memoryGateSettings({}),
      read: () => readHostMemory(darwin),
      sampleMs: 2_000,
      now: () => clock,
      log,
    });
    expect((await gate.admission()).claim).toBe('none');
    clock = 1_999;
    expect((await gate.admission()).claim).toBe('none');
    expect(child.async).toHaveBeenCalledTimes(1);
    clock = 2_000;
    expect((await gate.admission()).claim).toBe('all');
    expect(child.async).toHaveBeenCalledTimes(2);
    // Logged a minute after the pause line, with the resume time in it.
    clock = 60_000;
    await gate.admission();
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate resumed claims',
      expect.objectContaining({
        source: 'memorystatus',
        restrictedMs: 2_000,
        stateMs: 58_000,
      }),
    );
  });
});
