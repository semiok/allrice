import { UuidSchema, runtimeStaticPreviewPolicy } from '@allrice/contracts';
import { z } from 'zod';
import {
  DataAccessError,
  CompanyAssetError,
  listCompanyAssets,
  listCompanyTemplateRecommendations,
  getCompanyAsset,
  listCompanyAssetRevisions,
  getCompanyAssetFile,
  mutateCompanyAsset,
  listCompanyRuleSources,
  readArtifactBytes,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { getRequestContext } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { readAdminJson } from '../tenant-administration/http';
import { executionErrorResponse } from '../execution/responses';
import { getStorageAdapter } from '../storage/runtime';
import { readStaticArtifactPreview } from '../runtime/static-artifact-preview';
const headers = {
  ...runtimeStaticPreviewPolicy('application/json').responseHeaders,
  'Cache-Control': 'private, no-store',
};
export async function companyAssetsHttp(
  request: Request,
  organizationInput?: string,
) {
  try {
    if (!['GET', 'POST'].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: 'GET, POST' },
      });
    const administration = !!organizationInput,
      authenticated = administration
        ? await requirePlatformAdminContext(request)
        : await getRequestContext(request);
    if (!authenticated) throw new DataAccessError('authentication_required');
    const requestedWorkspace = new URL(request.url).searchParams.get(
      'workspaceId',
    );
    const context =
      !administration && requestedWorkspace
        ? {
            ...authenticated,
            workspaceId: UuidSchema.parse(requestedWorkspace),
          }
        : authenticated;
    const org = UuidSchema.parse(organizationInput ?? context.organizationId),
      p = new URL(request.url).searchParams;
    if (request.method === 'POST') {
      if (!sameOriginBrowserWrite(request))
        return Response.json(
          { error: { message: '请求来源不匹配，请刷新页面。' } },
          { status: 403, headers },
        );
      return Response.json(
        await mutateCompanyAsset(
          context,
          org,
          await readAdminJson(request, 100_000),
          getStorageAdapter(),
          administration,
        ),
        { headers },
      );
    }
    if (p.get('sources') === '1') {
      if (!administration) throw new DataAccessError('authorization_denied');
      return Response.json(await listCompanyRuleSources(context, org), {
        headers,
      });
    }
    const id = p.has('assetId') ? UuidSchema.parse(p.get('assetId')) : null;
    if (!id && p.get('recommendations') === '1') {
      if (administration) throw new DataAccessError('authorization_denied');
      return Response.json(
        await listCompanyTemplateRecommendations(
          context,
          org,
          UuidSchema.parse(p.get('employeeId')),
          p.get('task') ?? '',
        ),
        { headers },
      );
    }
    if (!id)
      return Response.json(
        await listCompanyAssets(context, org, {
          administration,
          after: p.has('after') ? UuidSchema.parse(p.get('after')) : undefined,
        }),
        { headers },
      );
    if (p.get('history') === '1')
      return Response.json(
        await listCompanyAssetRevisions(context, org, id, administration),
        { headers },
      );
    if (p.get('preview') === '1' || p.get('download') === '1') {
      const revisionId = UuidSchema.parse(p.get('revisionId'));
      const first = await getCompanyAssetFile(
        context,
        org,
        id,
        revisionId,
        administration,
      );
      const value =
        p.get('download') === '1'
          ? await readArtifactBytes(
              getStorageAdapter(),
              first.object,
              64_000_000,
            )
          : await readStaticArtifactPreview(
              {
                object: first.object,
                kind: 'document',
                version: { fileName: first.file.fileName },
              },
              {
                source: p.get('source') === '1',
                offset: p.has('offset')
                  ? z.coerce
                      .number()
                      .int()
                      .min(1)
                      .max(1_000_000)
                      .parse(p.get('offset'))
                  : undefined,
                signal: request.signal,
              },
            );
      const after = await getCompanyAssetFile(
        context,
        org,
        id,
        revisionId,
        administration,
      );
      if (
        after.object.id !== first.object.id ||
        after.object.checksum !== first.object.checksum ||
        after.digest !== first.digest
      )
        throw new CompanyAssetError('source_changed');
      if (Buffer.isBuffer(value))
        return new Response(new Uint8Array(value), {
          headers: {
            ...headers,
            'Content-Type': first.object.mediaType,
            'Content-Disposition': `attachment; filename="company-template"; filename*=UTF-8''${encodeURIComponent(first.file.fileName)}`,
            'Content-Length': String(value.length),
          },
        });
      return Response.json(value, { headers });
    }
    return Response.json(
      await getCompanyAsset(context, org, id, administration),
      { headers },
    );
  } catch (error) {
    if (error instanceof CompanyAssetError)
      return Response.json(
        {
          error: {
            code: error.code,
            message: (
              {
                version_conflict: '内容已有变化，请刷新后再修改。',
                rule_budget_exceeded:
                  '已发布规矩超过总内容预算。请先精简规矩；原有效版本继续可用。',
                source_changed: '所选材料已变化或不可读取，请重新选择。',
                asset_unavailable: '此公司范本已暂停、撤回或不可读取。',
                source_required: '请选择要共享的具体成果版本。',
                kind_conflict: '内容类别不可改变。',
              } as const
            )[error.code],
          },
        },
        { status: 409, headers },
      );
    return executionErrorResponse(error);
  }
}
