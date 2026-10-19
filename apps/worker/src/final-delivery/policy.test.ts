import { describe, expect, it } from 'vitest';
import { createDeliveryMarkup } from './markup.js';
import {
  checkFinalDelivery,
  type ArtifactIdentity,
  type DeliveryArtifact,
  type DeliveryMarkup,
  type DeliveryRequirement,
  type DeliverySnapshot,
} from './policy.js';

const id = (n: number): string =>
  '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  sessionId: id(4),
  runId: id(5),
};
const origin = 'https://allrice.example.test';
const markup: DeliveryMarkup = createDeliveryMarkup();
function artifact(n = 10, name = 'metrics.json'): DeliveryArtifact {
  return {
    scope: {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      sessionId: scope.sessionId,
    },
    objectId: id(n),
    versionId: id(n + 1),
    checksum: 'sha256:' + 'a'.repeat(64),
    fileName: name,
    originRunId: scope.runId,
    state: 'ready',
    immutable: true,
    deletedAt: null,
    retentionUntil: null,
  };
}
function identity(value: DeliveryArtifact): ArtifactIdentity {
  return {
    objectId: value.objectId,
    versionId: value.versionId,
    checksum: value.checksum,
  };
}
function required(
  value: DeliveryArtifact,
  change: Partial<DeliveryRequirement> = {},
): DeliveryRequirement {
  return {
    id: 'metrics',
    expected: identity(value),
    source: 'current_run',
    requireLink: true,
    requiredChecks: [],
    ...change,
  };
}
function snapshot(change: Partial<DeliverySnapshot> = {}): DeliverySnapshot {
  const a = artifact();
  return {
    scope: { ...scope },
    authorization: 'current',
    complete: true,
    now: '2026-10-19T12:00:00.000Z',
    ownedRunIds: [scope.runId],
    explicitReferenceVersionIds: [],
    artifacts: [a],
    checks: [],
    requirements: [required(a)],
    ...change,
  };
}
const link = (a = artifact()): string =>
  '[metrics.json](/api/v1/files/' + a.objectId + '/download?name=metrics.json)';
const check = (candidate = link(), facts = snapshot(), parser = markup) =>
  checkFinalDelivery({
    candidate,
    snapshot: facts,
    expectedScope: scope,
    markup: parser,
    managedOrigins: [origin],
  });
const codes = (decision: ReturnType<typeof check>) =>
  decision.issues.map((issue) => issue.code);
const tick = String.fromCharCode(96);
const fence = tick.repeat(3);

describe('deterministic final delivery policy', () => {
  it('rechecks expiry with the current clock while hashing stable facts', () => {
    const a = artifact();
    a.retentionUntil = '2026-10-19T12:00:30.000Z';
    const before = snapshot({
      artifacts: [a],
      now: '2026-10-19T12:00:00.000Z',
    });
    const later = { ...before, now: '2026-10-19T12:00:01.000Z' };
    const expired = { ...before, now: '2026-10-19T12:00:31.000Z' };
    const first = check(link(a), before);
    expect(first.status).toBe('valid');
    expect(check(link(a), later).factSetDigest).toBe(first.factSetDigest);
    expect(check(link(a), expired).factSetDigest).toBe(first.factSetDigest);
    expect(check(link(a), expired).status).toBe('evidence_unavailable');
  });
  it('binds complete quality receipts and refuses non-JSON evidence', () => {
    const base = snapshot();
    const withAudit = {
      ...base,
      qualityReceipts: [{ auditId: 'first', receipt: null }],
    };
    expect(check(link(), withAudit).factSetDigest).not.toBe(
      check(link(), base).factSetDigest,
    );
    expect(
      check(link(), { ...base, qualityReceipts: [undefined] }).status,
    ).toBe('evidence_unavailable');
  });

  it('rejects the exact original invalid slash link without rewriting the candidate', () => {
    const candidate =
      '已完成，更正后总贡献下降 **1,997.90元**。\n\n- [metrics.json](／api) no incorrect need actual.\n';
    const decision = check(candidate);
    expect(decision.status).toBe('invalid_response');
    expect(decision.textRepairEligible).toBe(true);
    expect(codes(decision)).toContain('invalid_delivery_link');
    expect(candidate).toContain('(／api) no incorrect need actual.');
    expect(decision).not.toHaveProperty('answer');
    expect(JSON.stringify(decision)).not.toContain('／api');
  });

  it('accepts only the exact immutable object/version/checksum from current authority', () => {
    const decision = check();
    expect(decision.status).toBe('valid');
    expect(decision.linked).toEqual([identity(artifact())]);
    expect(decision.textRepairEligible).toBe(false);
  });

  it('accepts actual five-file delivery facts without requiring every intermediate file to be linked', () => {
    const artifacts = [
      'operations.py.txt',
      'metrics.json',
      'metrics.csv',
      'contribution-chart.png',
      'operations-report.docx',
    ].map((name, i) => artifact(20 + i * 2, name));
    const facts = snapshot({
      artifacts,
      requirements: artifacts.map((a, i) =>
        required(a, { id: 'output-' + i, requireLink: false }),
      ),
    });
    expect(check(link(artifacts[1]!), facts).status).toBe('valid');
  });

  it.each([
    '/api',
    '/api/v1/files/',
    '/api/v1/files/1234',
    '／api',
    '／api／v1／files／1234',
  ])('does not guess identity for malformed %s', (href) => {
    expect(codes(check('[metrics.json](' + href + ')'))).toContain(
      'invalid_delivery_link',
    );
  });

  it('never repairs an unknown UUID merely because the link label names a real file', () => {
    expect(
      codes(check('[metrics.json](/api/v1/files/' + id(999) + ')')),
    ).toContain('invalid_delivery_link');
  });

  it('does not treat the name query as object identity or select an artifact by filename', () => {
    const a = artifact(),
      b = artifact(20, 'different.csv');
    const decision = check(
      '[wrong](/api/v1/files/' + a.objectId + '/download?name=different.csv)',
      snapshot({ artifacts: [a, b] }),
    );
    expect(decision.linked).toEqual([identity(a)]);
  });

  it('binds an optional checksum prefix and UUID case canonically', () => {
    const a = artifact();
    a.objectId = 'ABCDABCD-ABCD-4BCD-8BCD-ABCDABCDABCD';
    a.versionId = 'FEDCFEDC-FEDC-4EDC-8EDC-FEDCFEDCFEDC';
    a.checksum = 'A'.repeat(64);
    expect(
      check(link(a), snapshot({ artifacts: [a], requirements: [required(a)] }))
        .status,
    ).toBe('valid');
  });

  it('does not substitute a same-name old version for the required new version', () => {
    const old = artifact(),
      current = artifact(20);
    const facts = snapshot({
      artifacts: [old, current],
      requirements: [required(current)],
    });
    const decision = check(link(old), facts);
    expect(decision.linked).toEqual([identity(old)]);
    expect(codes(decision)).toContain('missing_delivery_link');
  });

  it('does not certify a different checksum for the same named output', () => {
    const expected = artifact();
    expected.checksum = 'sha256:' + 'b'.repeat(64);
    const decision = check(
      link(),
      snapshot({ requirements: [required(expected)] }),
    );
    expect(codes(decision)).toContain('missing_requested_artifact');
    expect(decision.textRepairEligible).toBe(false);
  });

  it('rejects a required artifact that has not been published', () => {
    const decision = check(
      '文件稍后补充。',
      snapshot({
        artifacts: [],
        requirements: [required(artifact())],
      }),
    );
    expect(codes(decision)).toContain('missing_requested_artifact');
    expect(decision.textRepairEligible).toBe(false);
  });

  it('keeps an explicitly unfilled requirement unresolved rather than guessing by name', () => {
    const decision = check(
      link(),
      snapshot({ requirements: [required(artifact(), { expected: null })] }),
    );
    expect(codes(decision)).toContain('missing_requested_artifact');
  });

  it('permits a server-owned child Run output but not an arbitrary Run output', () => {
    const a = artifact();
    a.originRunId = id(30);
    expect(
      check(
        link(a),
        snapshot({ artifacts: [a], ownedRunIds: [scope.runId, id(30)] }),
      ).status,
    ).toBe('valid');
    expect(check(link(a), snapshot({ artifacts: [a] })).status).toBe(
      'evidence_unavailable',
    );
  });

  it('allows an explicitly bound old reference and keeps it separate from new output slots', () => {
    const a = artifact();
    a.originRunId = id(30);
    const facts = snapshot({
      artifacts: [a],
      explicitReferenceVersionIds: [a.versionId],
      requirements: [required(a, { source: 'explicit_reference' })],
    });
    expect(check(link(a), facts).status).toBe('valid');
    expect(
      codes(check(link(a), { ...facts, requirements: [required(a)] })),
    ).toContain('missing_requested_artifact');
  });

  it.each(['organizationId', 'workspaceId', 'ownerId', 'sessionId'] as const)(
    'rejects artifacts crossing %s',
    (field) => {
      const a = artifact();
      a.scope[field] = id(99);
      expect(check(link(a), snapshot({ artifacts: [a] })).status).toBe(
        'evidence_unavailable',
      );
    },
  );

  it('rejects a different root Run snapshot', () => {
    const facts = snapshot({ scope: { ...scope, runId: id(99) } });
    expect(check(link(), facts).status).toBe('evidence_unavailable');
  });

  it.each([
    { deletedAt: '2026-10-18T00:00:00.000Z' },
    { retentionUntil: '2026-10-19T12:00:00.000Z' },
    { retentionUntil: 'invalid' },
    { state: 'pending' as const },
    { immutable: false },
  ])('rejects unavailable artifact facts %j', (change) => {
    const a = { ...artifact(), ...change };
    expect(check(link(a), snapshot({ artifacts: [a] })).status).toBe(
      'evidence_unavailable',
    );
  });

  it('rejects an incomplete page list even if the first page includes the linked output', () => {
    expect(check(link(), snapshot({ complete: false })).status).toBe(
      'evidence_unavailable',
    );
  });

  it('rejects an unknown authorization result rather than interpreting it as current', () => {
    const facts = snapshot();
    Object.assign(facts, { authorization: 'unknown' });
    expect(check(link(), facts).status).toBe('evidence_unavailable');
  });

  it('rejects inconsistent duplicate identities while allowing identical pagination duplicates', () => {
    const a = artifact();
    expect(
      check(link(), snapshot({ artifacts: [a, structuredClone(a)] })).status,
    ).toBe('valid');
    expect(
      check(
        link(),
        snapshot({ artifacts: [a, { ...a, fileName: 'other.json' }] }),
      ).status,
    ).toBe('evidence_unavailable');
    expect(
      check(link(), snapshot({ artifacts: [a, { ...a, versionId: id(88) }] }))
        .status,
    ).toBe('evidence_unavailable');
    expect(
      check(link(), snapshot({ artifacts: [a, { ...a, objectId: id(88) }] }))
        .status,
    ).toBe('evidence_unavailable');
  });

  it('requires exact artifact/run-bound passed receipts only when this task requires the check', () => {
    const a = artifact();
    const facts = snapshot({
      requirements: [required(a, { requiredChecks: ['saved-values'] })],
    });
    const receipt = {
      ...identity(a),
      scope: a.scope,
      originRunId: a.originRunId,
      checkId: 'saved-values',
      status: 'passed' as const,
    };
    expect(codes(check(link(), facts))).toContain('required_check_incomplete');
    expect(check(link(), { ...facts, checks: [receipt] }).status).toBe('valid');
    for (const change of [
      { checksum: 'sha256:' + 'b'.repeat(64) },
      { versionId: id(99) },
      { objectId: id(99) },
      { originRunId: id(99) },
      { scope: { ...a.scope, ownerId: id(99) } },
      { status: 'unavailable' as const },
      { status: 'failed' as const },
    ]) {
      const decision = check(link(), {
        ...facts,
        checks: [{ ...receipt, ...change }],
      });
      expect(codes(decision)).toContain('required_check_incomplete');
      expect(decision.textRepairEligible).toBe(false);
    }
    expect(
      check(
        link(),
        snapshot({ checks: [{ ...receipt, status: 'unavailable' }] }),
      ).status,
    ).toBe('valid');
  });

  it('does not let one passed receipt hide a conflicting failure for the exact required check', () => {
    const a = artifact();
    const receipt = {
      ...identity(a),
      scope: a.scope,
      originRunId: a.originRunId,
      checkId: 'saved-values',
      status: 'passed' as const,
    };
    expect(
      codes(
        check(
          link(),
          snapshot({
            requirements: [required(a, { requiredChecks: ['saved-values'] })],
            checks: [receipt, { ...receipt, status: 'failed' }],
          }),
        ),
      ),
    ).toContain('required_check_incomplete');
  });

  it('accepts reference-style exact file links using the real Markdown parser', () => {
    expect(
      check('[metrics][r]\n\n[r]: /api/v1/files/' + artifact().objectId).status,
    ).toBe('valid');
  });

  it('uses only the first Markdown definition and ignores unused bad definitions', () => {
    expect(check(link() + '\n\n[unused]: /api').status).toBe('valid');
    const text =
      '[metrics][r]\n\n[r]: /api\n[r]: /api/v1/files/' + artifact().objectId;
    expect(codes(check(text))).toContain('invalid_delivery_link');
  });

  it('ignores fenced code, inline code and quoted bad-link examples', () => {
    const text =
      link() +
      '\n\n' +
      fence +
      'md\n[bad](/api)\n' +
      fence +
      '\n' +
      '\n示例：' +
      tick +
      '[bad](/api)' +
      tick +
      '\n\n> [bad](/api)\n';
    expect(check(text).status).toBe('valid');
  });

  it('does not allow a quoted or code-only valid link to fulfill a required link slot', () => {
    expect(codes(check('> ' + link()))).toContain('missing_delivery_link');
    expect(codes(check(fence + '\n' + link() + '\n' + fence))).toContain(
      'missing_delivery_link',
    );
  });

  it('recognizes actual HTML links and image URLs without treating a download as a rendering check', () => {
    const a = artifact();
    expect(
      check('<a href="/api/v1/files/' + a.objectId + '">file</a>').status,
    ).toBe('valid');
    expect(codes(check('<a href="/api">file</a>'))).toContain(
      'invalid_delivery_link',
    );
    expect(check('![chart](/api/v1/files/' + a.objectId + ')').status).toBe(
      'valid',
    );
    expect(
      codes(
        check(
          '<a href="/api/v1/files/' + a.objectId + '">file</a>',
          snapshot({
            requirements: [required(a, { requiredChecks: ['page-rendered'] })],
          }),
        ),
      ),
    ).toContain('required_check_incomplete');
  });

  it('fails visibly if the markup parser cannot completely inspect HTML', () => {
    const parser = { ...markup, html: () => ({ complete: false, links: [] }) };
    expect(check(link() + '<span>text</span>', snapshot(), parser).status).toBe(
      'evidence_unavailable',
    );
  });

  it('leaves normal external source links and legitimate English untouched', () => {
    const candidate =
      link() +
      '\n[API docs](https://docs.example.test/api)\n' +
      'The phrase “need actual” can be a quoted requirement.';
    expect(check(candidate).status).toBe('valid');
    expect(candidate).toContain('need actual');
  });

  it('does not claim to detect semantic editorial residue after all deterministic facts pass', () => {
    expect(check(link() + ' no incorrect need actual.').status).toBe('valid');
  });

  it('rejects foreign origins for a managed file route instead of silently localizing the link', () => {
    const href =
      'https://foreign.example.test/api/v1/files/' + artifact().objectId;
    expect(codes(check('[file](' + href + ')'))).toContain(
      'invalid_delivery_link',
    );
    expect(
      check('[file](' + origin + '/api/v1/files/' + artifact().objectId + ')')
        .status,
    ).toBe('valid');
  });

  it('accepts identity-preserving separator escapes and the existing sandbox prefix only', () => {
    const objectId = artifact().objectId;
    expect(check('[file](sandbox:/api/v1/files/' + objectId + ')').status).toBe(
      'valid',
    );
    expect(check('[file](/api\\/v1\\/files\\/' + objectId + ')').status).toBe(
      'valid',
    );
    expect(codes(check('[file](sandbox:/api)'))).toContain(
      'missing_delivery_link',
    );
  });

  it.each(['?version=old', '#download'])(
    'rejects unverified managed URL selector %s',
    (suffix) => {
      expect(
        codes(
          check('[file](/api/v1/files/' + artifact().objectId + suffix + ')'),
        ),
      ).toContain('invalid_delivery_link');
    },
  );

  it('fails closed on parser errors, oversized text, node/link limits and artifact-list caps', () => {
    expect(
      check(link(), snapshot(), {
        ...markup,
        markdown: () => {
          throw Error('bad');
        },
      }).status,
    ).toBe('evidence_unavailable');
    expect(check('x'.repeat(256_001)).status).toBe('evidence_unavailable');
    expect(
      check('', snapshot(), {
        ...markup,
        markdown: () => ({
          type: 'root',
          children: Array.from({ length: 20_001 }, () => ({ type: 'text' })),
        }),
      }).status,
    ).toBe('evidence_unavailable');
    expect(
      check(Array.from({ length: 1_001 }, () => link()).join('\n')).status,
    ).toBe('evidence_unavailable');
    expect(
      check(
        link(),
        snapshot({
          artifacts: Array.from({ length: 1_001 }, () => artifact()),
        }),
      ).status,
    ).toBe('evidence_unavailable');
  });

  it('bounds issue diagnostics without allowing excessive invalid links to pass', () => {
    const decision = check(
      Array.from({ length: 150 }, () => '[bad](/api)').join('\n'),
    );
    expect(decision.status).toBe('evidence_unavailable');
    expect(decision.issues.length).toBeLessThanOrEqual(100);
  });

  it('uses stable fact/candidate digests for audit and never returns a changed body', () => {
    const a = artifact(),
      b = artifact(20, 'metrics.csv');
    const first = check(link(), snapshot({ artifacts: [a, b] }));
    const second = check(link(), snapshot({ artifacts: [b, a] }));
    expect(first.factSetDigest).toBe(second.factSetDigest);
    expect(first.candidateDigest).toBe(second.candidateDigest);
    expect(check(link() + ' ').candidateDigest).not.toBe(first.candidateDigest);
    expect(first).not.toHaveProperty('candidate');
  });

  it('does not require unrelated checks or make model/network/tool calls', () => {
    let parseCalls = 0;
    const parser = {
      ...markup,
      markdown: (text: string) => {
        parseCalls += 1;
        return markup.markdown(text);
      },
    };
    expect(check(link(), snapshot(), parser).status).toBe('valid');
    expect(parseCalls).toBe(1);
    // The only executable ports supplied here are synchronous markup parsers.
  });
});
