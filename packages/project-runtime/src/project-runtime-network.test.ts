import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { sandboxNetworkRelay } from './sandbox-network-relay.js';
import { sandboxNetworkPythonRelay } from './sandbox-network-python-relay.js';

describe('saved-project relay installation gate', () => {
  function nodeProbe(
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
  function probe(change: Parameters<typeof nodeProbe>[0] = {}) {
    const python = execFileSync(
      'python3',
      [
        '-I',
        '-S',
        '-c',
        sandboxNetworkPythonRelay.split('class Relay:')[0] +
          String.raw`
from types import SimpleNamespace
from unittest.mock import patch
change=json.loads(sys.argv[1]);sys.argv=['relay','3139','100000','project-runtime-v1']
opened=0;closed=0
def open_probe(path,flags):
    global opened
    assert flags==os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
    if change.get('missing'):raise FileNotFoundError()
    opened+=1;return 7
def close_probe(fd):
    global closed
    assert fd==7
    closed+=1
parent=SimpleNamespace(st_mode=(stat.S_IFLNK if change.get('parentSymlink') else stat.S_IFDIR)|(0o777 if change.get('parentWritable') else 0o755),st_uid=0)
file=SimpleNamespace(st_mode=(stat.S_IFIFO if change.get('regular') is False else stat.S_IFREG)|(0o644 if change.get('writable') else 0o444),st_uid=change.get('uid',0),st_nlink=change.get('links',1),st_size=5)
with patch.object(os,'lstat',return_value=parent),patch.object(os,'open',side_effect=open_probe),patch.object(os,'fstat',return_value=file),patch.object(os,'read',return_value=change.get('content','ready').encode()),patch.object(os,'close',side_effect=close_probe):
    ready=runtime_ready()
assert opened==closed
print(json.dumps(ready))
`,
        JSON.stringify(change),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    const node = nodeProbe(change);
    expect(JSON.parse(python)).toBe(node);
    return node;
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
