import { describe, expect, it, vi } from 'vitest';
import { nativeControlCloudEvidenceDigest as digest } from './native-control-cloud-evidence.ts';
import { nativeOnceDigest } from './native-schedule-once-state.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

describe('complete bounded cloud evidence digest', () => {
  it.each([
    { value: null },
    { value: [true, false, 17, '中文证据'] },
    { value: { z: [null, { b: 2, a: 1 }], a: 'complete' } },
  ])(
    'keeps the existing canonical digest for a small JSON document',
    ({ value }) => {
      expect(digest(value)).toBe(nativeOnceDigest(value));
      expect(digest(value)).toBe(runtimePolicyDigest(value));
    },
  );

  it('hashes every byte of a large observation and its complete credential', () => {
    const observation = {
      lifecycle: ['web', 'worker'].map((role) => ({
        identity: { role },
        completeDetail: 'original lifecycle detail;'.repeat(1500),
      })),
      inventory: [{ id: 'preserved-container', state: 'exited' }],
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
    };
    const credential = {
      observation,
      approval: { observationDigest: digest(observation) },
    };
    expect(Buffer.byteLength(JSON.stringify(observation))).toBeGreaterThan(
      65_536,
    );
    expect(() => nativeOnceDigest(observation)).toThrow(
      'native_once_json_limit',
    );
    expect(digest(credential)).toBe(runtimePolicyDigest(credential));
    expect(digest(JSON.parse(JSON.stringify(credential)))).toBe(
      digest(credential),
    );
    const changed = structuredClone(credential);
    changed.observation.lifecycle[1]!.completeDetail += 'changed final byte';
    expect(digest(changed.observation)).not.toBe(
      credential.approval.observationDigest,
    );
    expect(digest(changed)).not.toBe(digest(credential));
  });

  it('keeps key-order independence and accepts repeated non-cyclic values', () => {
    const detail = { first: 1, second: 'preserved' };
    expect(digest({ b: detail, a: detail })).toBe(
      digest({ a: { second: 'preserved', first: 1 }, b: detail }),
    );
  });

  it('enforces the exact UTF-8 ceiling on both observation and envelope', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ detail: '' }));
    const atLimit = { detail: 'x'.repeat(1_048_576 - overhead) };
    expect(digest(atLimit)).toBe(runtimePolicyDigest(atLimit));
    expect(() => digest({ detail: atLimit.detail + 'x' })).toThrow(
      'native_control_cloud_evidence_json_limit',
    );
    expect(() => digest({ observation: atLimit })).toThrow(
      'native_control_cloud_evidence_json_limit',
    );
    const unicode = { detail: '证'.repeat(350_000) };
    expect(JSON.stringify(unicode).length).toBeLessThan(1_048_576);
    expect(() => digest(unicode)).toThrow(
      'native_control_cloud_evidence_json_limit',
    );
  });

  it('retains the 20,000-node and depth-32 limits', () => {
    expect(() => digest(Array(19_999).fill(null))).not.toThrow();
    expect(() => digest(Array(20_000).fill(null))).toThrow(
      'native_control_cloud_evidence_json_limit',
    );
    let atLimit: unknown = null;
    for (let i = 0; i < 32; i++) atLimit = { child: atLimit };
    expect(() => digest(atLimit)).not.toThrow();
    expect(() => digest({ child: atLimit })).toThrow(
      'native_control_cloud_evidence_json_limit',
    );
  });

  it('rejects cycles and accessors without calling them', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => digest(cyclic)).toThrow(
      'native_control_cloud_evidence_invalid_json',
    );
    const getter = vi.fn(() => 'must not run');
    const accessor = Object.defineProperty({}, 'detail', {
      enumerable: true,
      get: getter,
    });
    expect(() => digest(accessor)).toThrow(
      'native_control_cloud_evidence_invalid_json',
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', { value: undefined }],
    ['nonfinite', { value: Infinity }],
    ['NaN', { value: NaN }],
    ['bigint', { value: 1n }],
    ['function', { value: () => null }],
    ['date', new Date(0)],
    ['nonplain object', Object.create(null)],
    ['sparse array', Array(2)],
    ['symbol key', { [Symbol('hidden')]: 'unhashed' }],
    ['hidden property', Object.defineProperty({}, 'hidden', { value: 1 })],
    ['extra array property', Object.assign([1], { extra: 'unhashed' })],
  ])('rejects %s instead of dropping unhashable data', (_name, value) => {
    expect(() => digest(value)).toThrow(
      'native_control_cloud_evidence_invalid_json',
    );
  });
});
