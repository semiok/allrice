import {
  ApiErrorSchema,
  EmployeeSkillCatalogSchema,
  PersonalSkillConfirmRequestSchema,
  PersonalSkillConfirmResponseSchema,
  PersonalSkillPreviewRequestSchema,
  PersonalSkillPreviewResponseSchema,
  PersonalSkillRemoveRequestSchema,
  PersonalSkillRemoveResponseSchema,
  SkillSourceErrorReasonSchema,
  personalSkillLimits,
  skillSourceErrorHeader,
  type EmployeeSkillCatalog,
  type PersonalSkillConfirmResponse,
  type PersonalSkillPreviewRequest,
  type PersonalSkillPreviewResponse,
  type SkillPackageSource,
  type SkillSourceErrorReason,
} from '@allrice/contracts';

export interface EmployeeSkillScope {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Readonly<Record<string, string>>;
}

export type EmployeeSkillTarget = PersonalSkillPreviewRequest['target'];
export type EmployeeSkillSourceInput =
  { kind: 'github'; url: string } | { kind: 'zip'; file: File };
export type EmployeeSkillOperation =
  'catalog' | 'preview' | 'confirm' | 'remove';
export type EmployeeCatalogSkill =
  EmployeeSkillCatalog['personalSkills'][number];

/** Technical facts only. The view maps approved reasons or receives explicit
 * host copy; arbitrary server messages and signed preview bytes are not shown. */
export class EmployeeSkillApiError extends Error {
  constructor(
    readonly operation: EmployeeSkillOperation,
    readonly kind:
      'rejected' | 'unknown' | 'invalid_response' | 'invalid_input',
    readonly status?: number,
    readonly reason?: SkillSourceErrorReason,
    readonly code?: ReturnType<typeof ApiErrorSchema.parse>['error']['code'],
  ) {
    super(`employee_skill_${operation}_${kind}`);
    this.name = 'EmployeeSkillApiError';
  }

  get accessLost() {
    return [401, 403, 404].includes(this.status ?? 0);
  }
}

const endpoint = (scope: EmployeeSkillScope) =>
  `/api/v1/employee-instances/${encodeURIComponent(scope.instanceId)}/skills`;

async function read(
  scope: EmployeeSkillScope,
  operation: EmployeeSkillOperation,
  path: string,
  init: RequestInit,
) {
  const write = operation === 'confirm' || operation === 'remove';
  const headers = new Headers({ ...scope.headers });
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  if (init.body instanceof FormData) headers.delete('Content-Type');
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new EmployeeSkillApiError(operation, write ? 'unknown' : 'rejected');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmployeeSkillApiError(
      operation,
      write ? 'unknown' : 'invalid_response',
      response.status,
    );
  }
  if (!response.ok) {
    const reason = SkillSourceErrorReasonSchema.safeParse(
      response.headers.get(skillSourceErrorHeader),
    );
    const problem = ApiErrorSchema.safeParse(body);
    throw new EmployeeSkillApiError(
      operation,
      write &&
        (!problem.success || response.status >= 500 || response.status === 408)
        ? 'unknown'
        : 'rejected',
      response.status,
      reason.success ? reason.data : undefined,
      problem.success ? problem.data.error.code : undefined,
    );
  }
  return body;
}

function invalidResponse(operation: EmployeeSkillOperation): never {
  throw new EmployeeSkillApiError(
    operation,
    operation === 'confirm' || operation === 'remove'
      ? 'unknown'
      : 'invalid_response',
  );
}

export async function readEmployeeSkills(
  scope: EmployeeSkillScope,
  signal?: AbortSignal,
) {
  const parsed = EmployeeSkillCatalogSchema.safeParse(
    await read(
      scope,
      'catalog',
      `${endpoint(scope)}?${new URLSearchParams({ workspaceId: scope.workspaceId })}`,
      { signal },
    ),
  );
  if (
    !parsed.success ||
    parsed.data.instanceId !== scope.instanceId ||
    parsed.data.personalSkills.some(
      (skill) =>
        skill.binding.instanceId !== scope.instanceId ||
        skill.binding.workspaceId !== scope.workspaceId ||
        !skill.binding.enabled,
    )
  )
    return invalidResponse('catalog');
  return parsed.data;
}

export async function previewEmployeeSkill(
  scope: EmployeeSkillScope,
  target: EmployeeSkillTarget,
  source: EmployeeSkillSourceInput,
  signal?: AbortSignal,
) {
  const input = PersonalSkillPreviewRequestSchema.safeParse({
    workspaceId: scope.workspaceId,
    target,
    source:
      source.kind === 'github'
        ? { kind: 'github', url: source.url }
        : { kind: 'zip', fileName: source.file.name },
  });
  if (
    !input.success ||
    (source.kind === 'zip' &&
      (source.file.size === 0 ||
        source.file.size > personalSkillLimits.archiveBytes))
  )
    throw new EmployeeSkillApiError('preview', 'invalid_input');
  let body: BodyInit;
  let headers: Record<string, string> = {};
  if (source.kind === 'zip') {
    const form = new FormData();
    form.append(
      'input',
      JSON.stringify({
        workspaceId: scope.workspaceId,
        target: input.data.target,
      }),
    );
    form.append('file', source.file);
    body = form;
  } else {
    body = JSON.stringify(input.data);
    headers = { 'Content-Type': 'application/json' };
  }
  const parsed = PersonalSkillPreviewResponseSchema.safeParse(
    await read(scope, 'preview', `${endpoint(scope)}/preview`, {
      method: 'POST',
      body,
      headers,
      signal,
    }),
  );
  if (!parsed.success) return invalidResponse('preview');
  const preview = parsed.data;
  if (
    preview.instanceId !== scope.instanceId ||
    preview.operation !== target.operation ||
    preview.target.operation !== target.operation ||
    !preview.files.some((file) => file.path === 'SKILL.md') ||
    preview.digest !== preview.source.originalChecksum
  )
    return invalidResponse('preview');
  if (
    source.kind === 'github'
      ? preview.source.kind !== 'github' ||
        preview.source.requestedUrl !== source.url
      : preview.source.kind !== 'zip' ||
        preview.source.fileName !== source.file.name ||
        preview.source.byteLength !== source.file.size
  )
    return invalidResponse('preview');
  if (target.operation === 'update') {
    if (
      preview.target.operation !== 'update' ||
      preview.target.installationId !== target.installationId ||
      preview.target.expectedRevision !== target.expectedRevision ||
      preview.target.expectedVersionId !== target.expectedVersionId ||
      !preview.affectedBindings?.some(
        (binding) =>
          binding.instanceId === scope.instanceId &&
          binding.workspaceId === scope.workspaceId &&
          binding.enabled,
      )
    )
      return invalidResponse('preview');
  }
  return preview;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  const a = Object.entries(left).sort(),
    b = Object.entries(right).sort();
  return (
    a.length === b.length &&
    a.every(([key, value], index) =>
      b[index]?.[0] === key ? sameValue(value, b[index]?.[1]) : false,
    )
  );
}

function matchesPreviewSource(
  actual: EmployeeCatalogSkill['source'],
  expected: SkillPackageSource,
) {
  return expected.kind === 'github'
    ? actual.kind === 'github' && sameValue(actual, expected)
    : actual.kind === 'attachment' &&
        actual.fileName === expected.fileName &&
        actual.originalChecksum === expected.originalChecksum &&
        actual.byteLength === expected.byteLength &&
        actual.candidatePath === 'SKILL.md';
}

/** Replays retain their original receipt. `unchanged` is checked against the
 * selected current revision; it is never inferred from a repeated request. */
export async function confirmEmployeeSkill(
  scope: EmployeeSkillScope,
  preview: PersonalSkillPreviewResponse,
  requestId: string,
  current?: EmployeeCatalogSkill,
  signal?: AbortSignal,
): Promise<PersonalSkillConfirmResponse> {
  if (
    preview.instanceId !== scope.instanceId ||
    preview.operation !== preview.target.operation ||
    (preview.target.operation === 'update' &&
      (!current ||
        current.installationId !== preview.target.installationId ||
        current.revision !== preview.target.expectedRevision ||
        current.versionId !== preview.target.expectedVersionId))
  )
    throw new EmployeeSkillApiError('confirm', 'invalid_input');
  const input = PersonalSkillConfirmRequestSchema.parse({
    workspaceId: scope.workspaceId,
    requestId,
    previewId: preview.previewId,
    digest: preview.digest,
  });
  const parsed = PersonalSkillConfirmResponseSchema.safeParse(
    await read(scope, 'confirm', `${endpoint(scope)}/confirm`, {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      signal,
    }),
  );
  if (!parsed.success) return invalidResponse('confirm');
  const result = parsed.data,
    receipt = result.receipt,
    skill = result.skill,
    binding = skill.bindings.find(
      (item) => item.instanceId === scope.instanceId,
    );
  if (
    preview.instanceId !== scope.instanceId ||
    receipt.operation !== preview.operation ||
    receipt.requestId !== requestId ||
    receipt.instanceId !== scope.instanceId ||
    receipt.installationId !== skill.id ||
    receipt.revision !== skill.revision ||
    receipt.versionId !== skill.versionId ||
    receipt.definitionChecksum !== skill.definitionChecksum ||
    receipt.packageChecksum !== skill.packageChecksum ||
    !sameValue(receipt.source, skill.source) ||
    skill.name !== preview.item.name ||
    skill.state !== 'installed' ||
    !binding?.enabled ||
    binding.workspaceId !== scope.workspaceId
  )
    return invalidResponse('confirm');
  if (preview.target.operation === 'update') {
    if (
      !current ||
      current.installationId !== preview.target.installationId ||
      current.revision !== preview.target.expectedRevision ||
      current.versionId !== preview.target.expectedVersionId ||
      receipt.installationId !== current.installationId ||
      !sameValue(result.affectedBindings, preview.affectedBindings) ||
      !sameValue(receipt.affectedBindings, preview.affectedBindings)
    )
      return invalidResponse('confirm');
    if (receipt.unchanged) {
      if (
        receipt.versionId !== current.versionId ||
        receipt.revision !== current.revision ||
        !sameValue(receipt.source, current.source)
      )
        return invalidResponse('confirm');
    } else if (
      receipt.versionId === current.versionId ||
      receipt.revision !== current.revision + 1 ||
      !matchesPreviewSource(receipt.source, preview.source)
    )
      return invalidResponse('confirm');
  } else {
    const expected = preview.target.expectedInstallation;
    if (
      expected
        ? receipt.installationId !== expected.id ||
          receipt.versionId !== expected.versionId ||
          ![expected.revision, expected.revision + 1].includes(
            receipt.revision,
          ) ||
          receipt.source.originalChecksum !== preview.source.originalChecksum
        : receipt.revision !== 1 ||
          !matchesPreviewSource(receipt.source, preview.source)
    )
      return invalidResponse('confirm');
  }
  return result;
}

export async function removeEmployeeSkill(
  scope: EmployeeSkillScope,
  current: EmployeeCatalogSkill,
  requestId: string,
  signal?: AbortSignal,
) {
  if (
    !current.canUninstall ||
    !current.binding.enabled ||
    current.binding.instanceId !== scope.instanceId ||
    current.binding.workspaceId !== scope.workspaceId
  )
    throw new EmployeeSkillApiError('remove', 'invalid_input');
  const input = PersonalSkillRemoveRequestSchema.parse({
    workspaceId: scope.workspaceId,
    expectedRevision: current.revision,
    requestId,
  });
  const parsed = PersonalSkillRemoveResponseSchema.safeParse(
    await read(
      scope,
      'remove',
      `${endpoint(scope)}/${encodeURIComponent(current.installationId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
        signal,
      },
    ),
  );
  if (!parsed.success) return invalidResponse('remove');
  const receipt = parsed.data.receipt;
  if (
    receipt.requestId !== requestId ||
    receipt.workspaceId !== scope.workspaceId ||
    receipt.instanceId !== scope.instanceId ||
    receipt.installationId !== current.installationId ||
    receipt.revision !== current.revision + 1 ||
    receipt.versionId !== current.versionId ||
    receipt.binding.id !== current.binding.id ||
    receipt.binding.instanceId !== scope.instanceId ||
    receipt.binding.workspaceId !== scope.workspaceId ||
    receipt.binding.enabled ||
    receipt.binding.epoch !== current.binding.epoch + 1
  )
    return invalidResponse('remove');
  return parsed.data;
}
