import { InvestmentContentSchema, UuidSchema } from '@allrice/contracts';
import { z } from 'zod';
import {
  DataAccessError,
  InvestmentEvidenceError,
  listInvestmentEntries,
  saveInvestmentEntry,
  readInvestmentReport,
} from '@allrice/database';
import { getRequestContext } from '../identity/session';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { readAdminJson } from '../tenant-administration/http';
import { executionErrorResponse } from '../execution/responses';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
const kinds = InvestmentContentSchema.options.map((s) => s.shape.kind.value);
export async function investmentHttp(
  request: Request,
  organizationInput?: string,
) {
  try {
    const administration = !!organizationInput;
    const authenticated = administration
      ? await requirePlatformAdminContext(request)
      : await getRequestContext(request);
    if (!authenticated) throw new DataAccessError('authentication_required');
    const p = new URL(request.url).searchParams;
    const context =
      !administration && p.has('workspaceId')
        ? {
            ...authenticated,
            workspaceId: UuidSchema.parse(p.get('workspaceId')),
          }
        : authenticated;
    const org = UuidSchema.parse(organizationInput ?? context.organizationId);
    if (request.method === 'POST') {
      if (!sameOriginBrowserWrite(request))
        return Response.json(
          { error: { message: '请求来源不匹配，请刷新页面。' } },
          { status: 403, headers },
        );
      return Response.json(
        await saveInvestmentEntry(
          context,
          org,
          await readAdminJson(request, 100_000),
          administration,
        ),
        { headers },
      );
    }
    if (request.method !== 'GET')
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: 'GET, POST' },
      });
    if (p.get('report') === '1' || p.get('export') === '1') {
      if (!administration) throw new DataAccessError('authorization_denied');
      const report = await readInvestmentReport(context, org, {
        range: p.get('range') ?? '7d',
        from: p.get('from') ?? undefined,
        to: p.get('to') ?? undefined,
        timeZone: p.get('timeZone') ?? undefined,
        userId: p.get('userId') ?? undefined,
        employeeId: p.get('employeeId') ?? undefined,
        jobTitle: p.get('jobTitle') ?? undefined,
      });
      return Response.json(report, {
        headers:
          p.get('export') === '1'
            ? {
                ...headers,
                'Content-Disposition':
                  'attachment; filename="allrice-investment-evidence.json"',
              }
            : headers,
      });
    }
    const kind = p.has('kind') ? z.enum(kinds).parse(p.get('kind')) : undefined;
    return Response.json(
      await listInvestmentEntries(context, org, {
        administration,
        kind,
        entryId: p.get('entryId') ?? undefined,
        after: p.get('after') ?? undefined,
        sourceVersionId: p.get('sourceVersionId') ?? undefined,
        history: p.get('history') === '1',
      }),
      { headers },
    );
  } catch (error) {
    if (error instanceof InvestmentEvidenceError)
      return Response.json(
        {
          error: {
            code: error.code,
            message: {
              version_conflict:
                '记录已有变化，请刷新后核对，避免覆盖他人的修改。',
              source_unavailable: '来源工作或所选成果版本不可用，请重新选择。',
              baseline_unavailable: '所选人工基准不可用，请重新选择。',
              allocation_exceeded:
                '订阅分摊超过总费用，请核对各公司的现有声明。',
              expense_revision_changed:
                '订阅费用已有新版本，请核对后选择最新版本；历史声明保持原版本。',
              business_work_exists:
                '业务标识、成果版本或费用依据已登记，请查看现有记录。',
              scope_mismatch: '期间、币种或授权范围不匹配，请核对来源。',
            }[error.code],
          },
        },
        { status: 409, headers },
      );
    return executionErrorResponse(error);
  }
}
