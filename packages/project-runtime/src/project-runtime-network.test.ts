import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import { sandboxNetworkRelay } from './sandbox-network-relay.js';

describe('saved-project relay installation gate', () => {
  function probe(
    change: {
      parentWritable?: boolean;
      parentSymlink?: boolean;
      uid?: number;
      writable?: boolean;
      links?: number;
      regular?: boolean;
      missing?: boolean;
      content?: string;
    } = {},
  ) {
    let opened = 0,
      closed = 0;
    const fs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 },
      lstatSync: () => ({
        isDirectory: () => !change.parentSymlink,
        uid: 0,
        mode: change.parentWritable ? 0o777 : 0o755,
      }),
      openSync: (_path: string, flags: number) => {
        expect(flags).toBe(3);
        if (change.missing) throw Error('ENOENT');
        opened++;
        return 7;
      },
      fstatSync: () => ({
        isFile: () => change.regular !== false,
        uid: change.uid ?? 0,
        nlink: change.links ?? 1,
        size: 5,
        mode: change.writable ? 0o644 : 0o444,
      }),
      readFileSync: () => change.content ?? 'ready',
      closeSync: () => closed++,
    };
    const ready = runInNewContext(
      sandboxNetworkRelay.split('const connections=')[0] + 'runtimeReady()',
      {
        process: { argv: ['node', '3139', '100000', 'project-runtime-v1'] },
        require: (name: string) => (name === 'node:fs' ? fs : {}),
      },
    );
    expect(closed).toBe(opened);
    return ready;
  }
  it('opens only for the fixed supervisor root-owned read-only completion marker', () =>
    expect(probe()).toBe(true));
  it.each([
    { missing: true },
    { parentWritable: true },
    { parentSymlink: true },
    { uid: 1000 },
    { writable: true },
    { links: 2 },
    { regular: false },
    { content: 'later' },
  ])('denies installation/tenant-forged marker %s', (change) =>
    expect(probe(change)).toBe(false),
  );
});
