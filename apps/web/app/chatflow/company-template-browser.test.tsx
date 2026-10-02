import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CompanyAssetSchema, type CompanyAsset } from '@allrice/contracts';
import {
  CompanyAssetRevisionView,
  companyRevisionReadable,
} from './company-template-browser';
import {
  CompanyTemplateEditor,
  companyAssetActions,
  companyAssetJson,
  companyAssetUrl,
} from './company-template-publisher';

function asset(): CompanyAsset {
  const objectId = randomUUID();
  const revisionId = randomUUID();
  return CompanyAssetSchema.parse({
    id: randomUUID(),
    organizationId: randomUUID(),
    ownerId: randomUUID(),
    ownerName: '普通成员',
    kind: 'template',
    state: 'published',
    revision: 2,
    publishedRevisionId: revisionId,
    canEdit: true,
    latest: {
      id: revisionId,
      number: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      createdAt: '2026-10-02T12:00:00Z',
      content: {
        kind: 'template',
        title: '中文公司范本',
        body: '填入联系人员，核对后发送。',
        category: '',
        appliesToEmployeeIds: [],
        taskKeywords: [],
        slots: [
          {
            key: 'internal_contact',
            label: '联系人员',
            required: true,
            multiline: false,
          },
        ],
        sourceVersionId: randomUUID(),
      },
      file: {
        objectId,
        checksum: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 1200,
        mediaType: 'text/plain',
        fileName: '中文 范本.txt',
        format: 'text',
      },
    },
  });
}

describe('company template UI publication and fixed revision boundaries', () => {
  it('keeps workspace and exact revision in preview/paging/download URLs', () => {
    const row = asset();
    const base = companyAssetUrl('/api/v1/company-assets', {
      workspaceId: randomUUID(),
    });
    const page = companyAssetUrl(base, {
      assetId: row.id,
      revisionId: row.latest.id,
      preview: '1',
    });
    const query = new URL(`${page}&source=1&offset=5001`, 'http://localhost')
      .searchParams;
    expect(query.get('workspaceId')).toBe(
      new URL(base, 'http://localhost').searchParams.get('workspaceId'),
    );
    expect(query.get('assetId')).toBe(row.id);
    expect(query.get('revisionId')).toBe(row.latest.id);
    expect(query.get('offset')).toBe('5001');
  });
  it('denies new bytes for unpublished revisions and paused/withdrawn/archived assets', () => {
    const row = asset();
    expect(companyRevisionReadable(row, row.latest, [row.latest.id])).toBe(
      true,
    );
    expect(companyRevisionReadable(row, row.latest, [])).toBe(false);
    for (const state of ['draft', 'paused', 'withdrawn', 'archived'] as const)
      expect(
        companyRevisionReadable({ ...row, state }, row.latest, [row.latest.id]),
      ).toBe(false);
    expect(
      companyRevisionReadable(row, { ...row.latest, file: null }, [
        row.latest.id,
      ]),
    ).toBe(false);
  });
  it('never exposes editing operations for another member and preserves resume versus publish semantics', () => {
    const row = asset();
    expect(companyAssetActions({ ...row, canEdit: false })).toEqual([]);
    expect(companyAssetActions({ ...row, state: 'archived' })).toEqual([]);
    expect(companyAssetActions(row)).toEqual([
      'pause',
      'withdraw',
      'pin',
      'archive',
    ]);
    expect(companyAssetActions({ ...row, pinned: true })).toEqual([
      'pause',
      'withdraw',
      'unpin',
      'archive',
    ]);
    const newerDraft = {
      ...row,
      latest: { ...row.latest, id: randomUUID(), number: 2 },
      revision: 3,
    };
    expect(companyAssetActions(newerDraft)).toEqual([
      'publish',
      'pause',
      'withdraw',
      'pin',
      'archive',
    ]);
    expect(companyAssetActions({ ...newerDraft, state: 'paused' })).toEqual([
      'publish',
      'resume',
      'withdraw',
      'archive',
    ]);
    expect(companyAssetActions({ ...row, state: 'withdrawn' })).toEqual([
      'resume',
      'archive',
    ]);
  });
  it('shows slot labels instead of technical keys, separates save from publication and makes no read/write during render', () => {
    const row = asset();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const html = renderToStaticMarkup(
        <CompanyTemplateEditor
          base="/api/v1/company-assets"
          headers={{}}
          initial={row}
          versionId={row.latest.content.sourceVersionId!}
          fileName={row.latest.file!.fileName}
        />,
      );
      expect(html).toContain('联系人员');
      expect(html).not.toContain('internal_contact');
      expect(html).not.toContain('sourceVersionId');
      expect(html).toContain('保存范本草稿');
      expect(html).toContain('私人会话');
      expect(html).not.toContain('自动复用');
      expect(fetch).not.toHaveBeenCalled();
      const newDraft = {
        ...row,
        latest: { ...row.latest, id: randomUUID(), number: 2 },
      };
      const detail = renderToStaticMarkup(
        <CompanyAssetRevisionView
          initial={newDraft}
          base="/api/v1/company-assets"
          headers={{}}
        />,
      );
      expect(detail).toContain('所选修订不在当前可读历史中');
      expect(detail).not.toContain('下载此修订原文件');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([403, 404])(
    'keeps a %i denial but uses company-content wording without retrying',
    async (status) => {
      const code =
        status === 404 ? 'RESOURCE_NOT_FOUND' : 'AUTHORIZATION_DENIED';
      const fetch = vi.fn(async () =>
        Response.json(
          {
            error: {
              code,
              message: status === 404 ? 'Run not found' : 'Access denied',
            },
          },
          { status },
        ),
      );
      vi.stubGlobal('fetch', fetch);
      try {
        await expect(
          companyAssetJson(
            '/api/v1/company-assets?assetId=withdrawn&history=1',
            {},
          ),
        ).rejects.toMatchObject({
          status,
          code,
          message:
            '当前公司资料不可访问，可能已撤回或权限已变更，请刷新后核对。',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it('keeps a CAS conflict explicit and does not retry the mutation', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'version_conflict',
            message: '内容已有变化，请刷新后再修改。',
          },
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(
        companyAssetJson(
          '/api/v1/company-assets',
          {},
          { method: 'POST', body: '{}' },
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'version_conflict',
        message: '内容已有变化，请刷新后再修改。',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
