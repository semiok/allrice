import { describe, expect, it } from 'vitest';
import {
  RuntimePolicyError,
  runtimePolicyDigest,
} from './runtime-policy-digest.ts';
import {
  RuntimePolicyError as publicError,
  runtimePolicyDigest as publicDigest,
} from './runtime-policy.ts';

describe('runtime policy digest compatibility', () => {
  it('keeps the existing public function and error identity', () => {
    expect(publicDigest).toBe(runtimePolicyDigest);
    expect(publicError).toBe(RuntimePolicyError);
  });

  // Frozen with the implementation in 776d7943, before extracting the leaf.
  it.each([
    {
      name: 'empty object',
      value: {},
      digest:
        'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    },
    {
      name: 'nested Unicode, numeric keys and signed zero',
      value: {
        z: [true, null, 0, -0, 1.25],
        a: { '2': 'b', '10': 'a', 中: '确认', é: 'café' },
      },
      digest:
        'sha256:b4d9aee91ee2a77ef70223ce36b9d9e8b7d82e8ee9c67342d10f0c5465771537',
    },
    {
      name: 'exact native answer',
      value: [{ selected: ['确认启用'], custom: null }],
      digest:
        'sha256:7870ba5069fb7a9136c44a3b0e0782f37d6431dc775b72b3ecbca81446c4d2fa',
    },
  ])('preserves persisted bytes for $name', ({ value, digest }) => {
    expect(runtimePolicyDigest(value)).toBe(digest);
    expect(publicDigest(value)).toBe(digest);
  });

  it('ignores object insertion order but preserves answer content and array order', () => {
    const answer = { selected: ['确认启用', '方案 A'], custom: null };
    expect(
      runtimePolicyDigest({ custom: null, selected: answer.selected }),
    ).toBe(publicDigest(answer));
    expect(
      runtimePolicyDigest({
        ...answer,
        selected: [...answer.selected].reverse(),
      }),
    ).not.toBe(publicDigest(answer));
    expect(runtimePolicyDigest({ ...answer, custom: '附带条件' })).not.toBe(
      publicDigest(answer),
    );
  });

  it.each([
    undefined,
    Number.NaN,
    Infinity,
    { answer: undefined },
    new Array(1),
    new Date(0),
  ])('retains non-JSON rejection for %s', (value) => {
    for (const digest of [runtimePolicyDigest, publicDigest]) {
      expect(() => digest(value)).toThrow(publicError);
      expect(() => digest(value)).toThrow('non_json_binding');
    }
  });
});
