// Actual fresh02 two Mounts entries, copied without Config.Env/source content.
// No Docker/Host/DB access: the remainder of this inspect is deliberately synthetic.
import { describe, expect, it } from 'vitest';
import {
  canonicalExitedContainerInspect as canonical,
  exitedContainerEvidenceDigest as digest,
} from './retirement-preserved-cloud.mjs';
const mounts = [
  {
    Type: 'volume',
    Name: 'allrice-project-work-91e4fa1c-14af-499a-a2dd-d1989ce056b9',
    Source:
      '/var/lib/docker/volumes/allrice-project-work-91e4fa1c-14af-499a-a2dd-d1989ce056b9/_data',
    Destination: '/tmp/work',
    Driver: 'local',
    Mode: 'z',
    RW: true,
    Propagation: '',
  },
  {
    Type: 'volume',
    Name: 'allrice-project-cache-4f1d97b0e91b2ef09fe98d54d2776c7c0cfe77f917e2f707c09d3b2cf770ef3c',
    Source:
      '/var/lib/docker/volumes/allrice-project-cache-4f1d97b0e91b2ef09fe98d54d2776c7c0cfe77f917e2f707c09d3b2cf770ef3c/_data',
    Destination: '/cache',
    Driver: 'local',
    Mode: 'z',
    RW: true,
    Propagation: '',
  },
];
function body() {
  return {
    Id: 'c059c14ced1dcd6664c7131382a5ef0975c7c6ce1245932892dd921c45a070be',
    Name: '/allrice-cloud-91e4fa1c-14af-499a-a2dd-d1989ce056b9',
    Created: '2026-10-04T02:24:40.086837435Z',
    State: { Status: 'exited', Pid: 0 },
    HostConfig: { RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } },
    Config: {
      Env: ['SYNTHETIC_A=1', 'SYNTHETIC_B=2'],
      Cmd: ['synthetic', '--read-only'],
    },
    Args: ['synthetic-first', 'synthetic-second'],
    Mounts: globalThis.structuredClone(mounts),
  };
}
describe('exact stopped inspect: only root Mounts order is unordered', () => {
  it('accepts the actual two-Mount permutation without mutating either full body', () => {
    const a = body(),
      b = body();
    b.Mounts.reverse();
    const beforeA = globalThis.structuredClone(a),
      beforeB = globalThis.structuredClone(b);
    expect(a.Mounts).toHaveLength(2);
    expect(a).not.toEqual(b);
    expect(canonical(a)).toEqual(canonical(b));
    expect(digest(a)).toBe(digest(b));
    expect(a).toEqual(beforeA);
    expect(b).toEqual(beforeB);
  });
  it.each([
    'Type',
    'Name',
    'Source',
    'Destination',
    'Driver',
    'Mode',
    'RW',
    'Propagation',
  ])('retains every complete mount field: %s', (key) => {
    const a = body(),
      b = body();
    b.Mounts.reverse();
    b.Mounts[0][key] =
      key === 'RW' ? !b.Mounts[0][key] : 'changed-' + b.Mounts[0][key];
    expect(canonical(a)).not.toEqual(canonical(b));
    expect(digest(a)).not.toBe(digest(b));
  });
  it.each(['Env', 'Cmd', 'Args'])('keeps %s order significant', (key) => {
    const a = body(),
      b = body();
    b.Mounts.reverse();
    (key === 'Args' ? b.Args : b.Config[key]).reverse();
    expect(canonical(a)).not.toEqual(canonical(b));
    expect(digest(a)).not.toBe(digest(b));
  });
  it('retains mount multiplicity and all additional fields', () => {
    const a = body(),
      b = body();
    b.Mounts.push(globalThis.structuredClone(b.Mounts[0]));
    expect(canonical(b).Mounts).toHaveLength(3);
    expect(digest(a)).not.toBe(digest(b));
    const c = body();
    c.Mounts[0].unknownFutureField = { ordered: ['first', 'second'] };
    const d = globalThis.structuredClone(c);
    d.Mounts.reverse();
    d.Mounts[1].unknownFutureField.ordered.reverse();
    expect(digest(c)).not.toBe(digest(d));
  });
  it('never sorts a nested inspect or unrelated root Mounts array', () => {
    const a = body(),
      b = body();
    b.Mounts.reverse();
    expect(digest({ observation: a })).not.toBe(digest({ observation: b }));
    expect(digest({ Mounts: a.Mounts })).not.toBe(digest({ Mounts: b.Mounts }));
  });
});
