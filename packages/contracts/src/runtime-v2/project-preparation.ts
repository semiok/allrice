import { z } from 'zod';
import {
  ProjectVersionRefSchema,
  type RuntimeSavedProjectSource,
} from '../project-workspace.ts';
import { runtimeContractEqual } from './identity.ts';
import { UuidSchema } from '../common.ts';
import { ChecksumSchema } from '../runs.ts';
import { isRuntimeRelativePath } from './policy.ts';
import { RuntimeNpmPackageSchema } from './dependency-preparation.ts';

export const projectPackageManagerVersions = Object.freeze({
  pnpm: '10.33.3',
  uv: '0.8.22',
});
const path = z.string().min(1).max(240).refine(isRuntimeRelativePath);
const wheel = z
  .object({
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .max(128),
    version: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9.!+_-]*$/)
      .max(80),
    fileName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*\.whl$/)
      .max(200),
    url: z
      .string()
      .url()
      .max(1024)
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === 'https:' &&
          u.hostname === 'files.pythonhosted.org' &&
          !u.port &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname.startsWith('/packages/')
        );
      }),
    sha256: ChecksumSchema,
    archivePath: path.optional(),
  })
  .strict();

/** PR8 installation contract, also consumed by the project workspace layer.
 * Source and lock identity are explicit; an installation never updates a lock.
 * The authority/scope is supplied by the operation binding, never by a model.
 */
export const RuntimeProjectPreparationSchema = z.discriminatedUnion('manager', [
  z
    .object({
      version: z.literal(1),
      projectId: UuidSchema,
      sourceDigest: ChecksumSchema,
      lockChecksum: ChecksumSchema,
      offline: z.boolean(),
      manager: z.literal('pnpm'),
      managerVersion: z.literal('10.33.3'),
      lockPath: path.refine((s) => s.endsWith('pnpm-lock.yaml')),
      scripts: z.enum(['disabled', 'allow_in_isolated_copy']),
      packages: z.array(RuntimeNpmPackageSchema).max(128),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      projectId: UuidSchema,
      sourceDigest: ChecksumSchema,
      lockChecksum: ChecksumSchema,
      offline: z.boolean(),
      manager: z.literal('uv'),
      managerVersion: z.literal('0.8.22'),
      lockPath: path.refine((s) => s.endsWith('requirements.lock')),
      scripts: z.literal('disabled'),
      packages: z.array(wheel).max(128),
    })
    .strict(),
]);
export type RuntimeProjectPreparation = z.infer<
  typeof RuntimeProjectPreparationSchema
>;

export const RuntimeProjectScopeSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
  })
  .strict();
export type RuntimeProjectScope = z.infer<typeof RuntimeProjectScopeSchema>;

/** Shared field order for the host/server cache key; callers SHA-256 this JSON. */
export function projectRuntimeCacheIdentity(input: {
  spec: RuntimeProjectPreparation;
  scope: RuntimeProjectScope;
  image: string;
  architecture: string;
}) {
  const { spec } = input;
  return {
    version: 1,
    scope: RuntimeProjectScopeSchema.parse(input.scope),
    projectId: spec.projectId,
    os: 'linux',
    architecture: input.architecture,
    image: input.image,
    manager: spec.manager,
    managerVersion: spec.managerVersion,
    lockChecksum: spec.lockChecksum,
  };
}

export const RuntimeProjectPreparationEvidenceSchema = z
  .object({
    version: z.literal(1),
    projectId: UuidSchema,
    sourceDigest: ChecksumSchema,
    lockChecksum: ChecksumSchema,
    cacheKey: ChecksumSchema,
    manager: z.enum(['pnpm', 'uv']),
    managerVersion: z.string().max(32),
    platform: z.enum(['linux-amd64', 'linux-arm64']),
    runtimeImage: ChecksumSchema,
    packageCount: z.number().int().min(0).max(128),
    archiveHits: z.number().int().min(0).max(128),
    downloadedArchives: z.number().int().min(0).max(128),
    downloadedBytes: z.number().int().min(0).max(64_000_000),
    installation: z.enum(['succeeded', 'failed', 'interrupted']),
    cacheVolume: z.string().regex(/^allrice-project-cache-[a-f0-9]{64}$/),
    sourceDirectoryModified: z.literal(false),
    hostEnvironmentModified: z.literal(false),
    savedSource: z
      .object({
        project: ProjectVersionRefSchema,
        restoredDigest: ChecksumSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeProjectPreparationEvidence = z.infer<
  typeof RuntimeProjectPreparationEvidenceSchema
>;

/** Same source, lock, cache and installation proof on either physical backend. */
export function projectPreparationResultMatches(input: {
  spec: RuntimeProjectPreparation;
  source?: RuntimeSavedProjectSource;
  imageDigest: string;
  proof?: RuntimeProjectPreparationEvidence;
  succeeded: boolean;
  commandFinished: boolean;
}) {
  const { spec, source, proof } = input;
  return (
    !!proof &&
    proof.version === spec.version &&
    proof.projectId === spec.projectId &&
    proof.sourceDigest === spec.sourceDigest &&
    proof.lockChecksum === spec.lockChecksum &&
    proof.manager === spec.manager &&
    proof.managerVersion === spec.managerVersion &&
    proof.runtimeImage === input.imageDigest &&
    proof.packageCount === spec.packages.length &&
    (source
      ? !!proof.savedSource &&
        runtimeContractEqual(proof.savedSource.project, source.project) &&
        proof.cacheKey === source.cacheKey &&
        proof.cacheVolume ===
          `allrice-project-cache-${source.cacheKey.slice(7)}` &&
        proof.platform === `linux-${source.architecture}` &&
        (proof.savedSource.restoredDigest === spec.sourceDigest ||
          (proof.savedSource.restoredDigest === null &&
            proof.installation !== 'succeeded' &&
            !input.commandFinished))
      : proof.savedSource === undefined) &&
    (!input.succeeded || proof.installation === 'succeeded')
  );
}

export const projectPreparationErrorLabels: Record<string, string> = {
  PROJECT_CACHE_LIMIT: '项目依赖缓存已达到上限，请结束当前运行后重试',
  PROJECT_SOURCE_CHANGED: '项目源码或锁文件版本已改变，请重新读取当前版本',
  PROJECT_LOCK_UNSUPPORTED: '此依赖锁格式或来源当前不支持，未开始安装',
  PROJECT_LOCK_MISMATCH: '锁文件与依赖归档清单不一致，未开始安装',
  PROJECT_DEPENDENCY_OFFLINE_MISS: '离线缓存缺少所需依赖，未开始安装',
  PROJECT_DEPENDENCY_UNAVAILABLE: '依赖下载失败，已完成的缓存保留',
  PROJECT_DEPENDENCY_INTEGRITY: '依赖完整性校验失败，未开始安装',
  PROJECT_DEPENDENCY_LIMIT: '依赖归档超过本次准备限额，未开始安装',
  PROJECT_SCOPE_REQUIRED: '项目准备缺少当前员工的执行范围',
  PROJECT_CACHE_UNSAFE: '项目缓存目录或运行盘状态异常，未开始安装',
  PROJECT_RUNTIME_UNAVAILABLE: '项目运行环境尚未就绪',
  PROJECT_TOOL_INTEGRITY: '固定项目工具的完整性校验失败，未开始安装',
};
