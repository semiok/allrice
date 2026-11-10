import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillSourceErrorHeader } from '@allrice/contracts';
import {
  employeeSkillPreviewName,
  employeeSkillPreviewVersion,
} from './employee-skill-confirmation';
import {
  confirmEmployeeSkill,
  previewEmployeeSkill,
  readEmployeeSkills,
  removeEmployeeSkill,
} from './employee-skills-api';
import {
  skillTestCatalog,
  skillTestConfirmed,
  skillTestId,
  skillTestPreview,
  skillTestProblem,
  skillTestRemoved,
  skillTestScope,
} from '../../test/employee-skills-host-data';

const requestId = skillTestId(900);
const current = () => {
  const value = skillTestCatalog().personalSkills[0];
  if (!value) throw new Error('Synthetic current Skill missing');
  return value;
};
const respond = (body: unknown, status = 200, headers?: HeadersInit) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(body, { status, headers }));
afterEach(() => vi.unstubAllGlobals());

describe('employee Skill browser HTTP contracts', () => {
  it('does not accept a catalog projected for a different employee or workspace', async () => {
    const catalog = skillTestCatalog(skillTestId(8));
    vi.stubGlobal('fetch', respond(catalog));
    await expect(readEmployeeSkills(skillTestScope)).rejects.toMatchObject({
      operation: 'catalog',
      kind: 'invalid_response',
    });
    catalog.instanceId = skillTestScope.instanceId;
    vi.stubGlobal('fetch', respond(catalog));
    await expect(readEmployeeSkills(skillTestScope)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('sends an actual ZIP File in multipart input without an inherited boundary', async () => {
    const file = new File(['abcde'], 'translation-review.zip', {
      type: 'application/zip',
    });
    const preview = skillTestPreview({
      operation: 'install',
      source: { kind: 'zip', fileName: file.name, byteLength: file.size },
    });
    const fetch = respond(preview);
    vi.stubGlobal('fetch', fetch);
    await expect(
      previewEmployeeSkill(
        {
          ...skillTestScope,
          headers: {
            ...skillTestScope.headers,
            'Content-Type': 'application/json',
          },
        },
        { operation: 'install' },
        { kind: 'zip', file },
      ),
    ).resolves.toEqual(preview);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/v1/employee-instances/${skillTestScope.instanceId}/skills/preview`,
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    if (!(init?.body instanceof FormData))
      throw new Error('Expected real multipart body');
    expect([...init.body.keys()]).toEqual(['input', 'file']);
    expect(JSON.parse(String(init.body.get('input')))).toEqual({
      workspaceId: skillTestScope.workspaceId,
      target: { operation: 'install' },
    });
    const uploaded = init.body.get('file');
    if (!(uploaded instanceof File)) throw new Error('Expected real File');
    expect(uploaded.name).toBe(file.name);
    expect(await uploaded.text()).toBe('abcde');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized real ZIP before any preview or installation request', async () => {
    const fetch = respond({});
    vi.stubGlobal('fetch', fetch);
    const file = new File([new Uint8Array(8_000_001)], 'too-large.zip');
    await expect(
      previewEmployeeSkill(
        skillTestScope,
        { operation: 'install' },
        { kind: 'zip', file },
      ),
    ).rejects.toMatchObject({ operation: 'preview', kind: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the complete disabled and cross-workspace update scope in its receipt', async () => {
    const preview = skillTestPreview(),
      result = skillTestConfirmed(preview, requestId);
    const fetch = respond(result);
    vi.stubGlobal('fetch', fetch);
    await expect(
      confirmEmployeeSkill(skillTestScope, preview, requestId, current()),
    ).resolves.toEqual(result);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/v1/employee-instances/${skillTestScope.instanceId}/skills/confirm`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: skillTestScope.workspaceId,
      requestId,
      previewId: preview.previewId,
      digest: preview.digest,
    });
    expect(
      result.affectedBindings?.map((binding) => [
        binding.workspaceLabel,
        binding.enabled,
      ]),
    ).toEqual([
      ['工作区一', true],
      ['工作区一', false],
      ['工作区二', true],
    ]);
  });

  it('accepts one affected employee and rejects a preview without the current enabled binding', async () => {
    const preview = skillTestPreview({ single: true }),
      selected = current();
    const fetch = respond(preview);
    vi.stubGlobal('fetch', fetch);
    const target = {
      operation: 'update' as const,
      installationId: selected.installationId,
      expectedRevision: selected.revision,
      expectedVersionId: selected.versionId,
    };
    const source = {
      kind: 'github' as const,
      url: 'https://github.com/example/translation-review',
    };
    const result = await previewEmployeeSkill(skillTestScope, target, source);
    expect(result.affectedBindings).toHaveLength(1);
    preview.affectedBindings = [];
    fetch.mockResolvedValue(Response.json(preview));
    await expect(
      previewEmployeeSkill(skillTestScope, target, source),
    ).rejects.toMatchObject({ operation: 'preview', kind: 'invalid_response' });
  });

  it('treats a truncated affected binding receipt as an unknown write outcome', async () => {
    const preview = skillTestPreview(),
      result = skillTestConfirmed(preview, requestId);
    result.receipt.affectedBindings = result.receipt.affectedBindings?.slice(
      0,
      1,
    );
    vi.stubGlobal('fetch', respond(result));
    await expect(
      confirmEmployeeSkill(skillTestScope, preview, requestId, current()),
    ).rejects.toMatchObject({ operation: 'confirm', kind: 'unknown' });
  });

  it('does not accept a receipt for another request or turn replay into unchanged', async () => {
    const preview = skillTestPreview(),
      wrong = skillTestConfirmed(preview, skillTestId(901));
    const fetch = respond(wrong);
    vi.stubGlobal('fetch', fetch);
    await expect(
      confirmEmployeeSkill(skillTestScope, preview, requestId, current()),
    ).rejects.toMatchObject({ kind: 'unknown' });
    const original = skillTestConfirmed(preview, requestId, false);
    fetch.mockResolvedValue(Response.json(original));
    const replay = await confirmEmployeeSkill(
      skillTestScope,
      preview,
      requestId,
      current(),
    );
    expect(replay.receipt.unchanged).toBe(false);
    expect(replay.receipt.versionId).not.toBe(current().versionId);
  });

  it('recognizes unchanged only with the original version revision and saved source', async () => {
    const preview = skillTestPreview(),
      result = skillTestConfirmed(preview, requestId, true);
    vi.stubGlobal('fetch', respond(result));
    await expect(
      confirmEmployeeSkill(skillTestScope, preview, requestId, current()),
    ).resolves.toEqual(result);
    result.receipt.revision += 1;
    result.skill.revision += 1;
    vi.stubGlobal('fetch', respond(result));
    await expect(
      confirmEmployeeSkill(skillTestScope, preview, requestId, current()),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('keeps an existing library source returned by install instead of inventing uploaded provenance', async () => {
    const preview = skillTestPreview({
        operation: 'install',
        source: { kind: 'zip', fileName: 'new-alias.zip', byteLength: 5 },
      }),
      selected = current();
    if (preview.target.operation !== 'install')
      throw new Error('Expected install preview');
    preview.target.expectedInstallation = {
      id: selected.installationId,
      revision: selected.revision,
      versionId: selected.versionId,
    };
    const result = skillTestConfirmed(preview, requestId);
    preview.source.originalChecksum = selected.source.originalChecksum;
    preview.digest = selected.source.originalChecksum;
    const source = selected.source;
    Object.assign(result.skill, {
      revision: selected.revision + 1,
      versionId: selected.versionId,
      version: selected.installationVersion,
      definitionChecksum: selected.definitionChecksum,
      source,
    });
    Object.assign(result.receipt, {
      revision: result.skill.revision,
      versionId: result.skill.versionId,
      definitionChecksum: selected.definitionChecksum,
      source,
    });
    vi.stubGlobal('fetch', respond(result));
    const confirmed = await confirmEmployeeSkill(
      skillTestScope,
      preview,
      requestId,
    );
    expect(confirmed.receipt.source).toEqual(source);
    expect(confirmed.receipt.source.fileName).toBe('translation-review.zip');
    expect(confirmed.receipt.source.fileName).not.toBe(preview.source.fileName);
  });

  it('removes only the selected employee binding with its exact CAS and request identity', async () => {
    const selected = current(),
      receipt = skillTestRemoved(requestId),
      fetch = respond(receipt);
    vi.stubGlobal('fetch', fetch);
    await expect(
      removeEmployeeSkill(skillTestScope, selected, requestId),
    ).resolves.toEqual(receipt);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      `/api/v1/employee-instances/${skillTestScope.instanceId}/skills/${selected.installationId}`,
    );
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({
      workspaceId: skillTestScope.workspaceId,
      expectedRevision: selected.revision,
      requestId,
    });
    expect(selected.binding.enabled).toBe(true);
    expect(receipt.receipt.binding).toEqual({
      ...selected.binding,
      enabled: false,
      epoch: selected.binding.epoch + 1,
    });
  });

  it('does not send a confirm or removal to a mismatched employee scope', async () => {
    const fetch = respond({});
    vi.stubGlobal('fetch', fetch);
    const scope = { ...skillTestScope, instanceId: skillTestId(8) };
    await expect(
      confirmEmployeeSkill(scope, skillTestPreview(), requestId, current()),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(
      removeEmployeeSkill(scope, current(), requestId),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the typed reason without interpreting arbitrary diagnostic messages', async () => {
    const fetch = respond(skillTestProblem(), 400, {
      [skillSourceErrorHeader]: 'skill_missing',
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      previewEmployeeSkill(
        skillTestScope,
        { operation: 'install' },
        {
          kind: 'github',
          url: 'https://github.com/example/translation-review',
        },
      ),
    ).rejects.toMatchObject({
      kind: 'rejected',
      reason: 'skill_missing',
      code: 'VALIDATION_FAILED',
    });
    fetch.mockResolvedValue(Response.json(skillTestProblem(), { status: 400 }));
    await expect(
      previewEmployeeSkill(
        skillTestScope,
        { operation: 'install' },
        {
          kind: 'github',
          url: 'https://github.com/example/translation-review',
        },
      ),
    ).rejects.toMatchObject({ reason: undefined });
  });

  for (const [label, displayName, version, expectedName, expectedVersion] of [
    ['absent', undefined, undefined, 'translation-review', '未提供'],
    ['empty', '', '', 'translation-review', '未提供'],
    ['whitespace', ' \t ', '\t ', 'translation-review', '未提供'],
    [
      'author string',
      ' 稿件校对 ',
      ' release-candidate ',
      ' 稿件校对 ',
      ' release-candidate ',
    ],
  ] as const) {
    it(`projects ${label} author metadata consistently with the real catalog`, () => {
      const preview = skillTestPreview();
      preview.item.displayName = displayName;
      preview.item.version = version;
      expect(employeeSkillPreviewName(preview)).toBe(expectedName);
      expect(employeeSkillPreviewVersion(preview)).toBe(expectedVersion);
    });
  }

  it.each(['transport', 'server', 'non-json', 'invalid-error-body'] as const)(
    'keeps %s confirm outcomes unknown instead of asserting failure',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failure === 'transport')
        fetch.mockRejectedValue(new Error('synthetic connection lost'));
      else if (failure === 'non-json')
        fetch.mockResolvedValue(new Response('not-json', { status: 200 }));
      else if (failure === 'invalid-error-body')
        fetch.mockResolvedValue(Response.json({}, { status: 409 }));
      else
        fetch.mockResolvedValue(
          Response.json(skillTestProblem(), { status: 503 }),
        );
      vi.stubGlobal('fetch', fetch);
      await expect(
        confirmEmployeeSkill(
          skillTestScope,
          skillTestPreview(),
          requestId,
          current(),
        ),
      ).rejects.toMatchObject({ operation: 'confirm', kind: 'unknown' });
    },
  );
});
