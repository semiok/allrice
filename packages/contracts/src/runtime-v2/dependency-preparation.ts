import { z } from 'zod';
import { isRuntimeRelativePath } from './policy.ts';

export const RuntimeNpmPackageSchema = z
  .object({
    name: z
      .string()
      .max(150)
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    version: z
      .string()
      .max(80)
      .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
    // Optional approved archive: same integrity and canonical registry identity,
    // but no download. Useful for air-gapped and explicitly prepared workspaces.
    archivePath: z.string().max(1024).refine(isRuntimeRelativePath).optional(),
  })
  .strict();
export type RuntimeNpmPackage = z.infer<typeof RuntimeNpmPackageSchema>;
export function runtimeNpmPackageUrl(pkg: RuntimeNpmPackage) {
  return `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`;
}
export const RuntimeDependencyPreparationSchema = z
  .object({
    manager: z.literal('npm'),
    strategy: z.literal('locked_ci'),
    registry: z.literal('https://registry.npmjs.org'),
    scripts: z.enum(['disabled', 'allow_in_isolated_copy']),
    packages: z.array(RuntimeNpmPackageSchema).min(1).max(8),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.packages.map((p) => `${p.name}@${p.version}`)).size !==
      v.packages.length
    )
      c.addIssue({ code: 'custom', message: 'duplicate package identity' });
  });
export const RuntimeDependencyPreparationResultSchema = z
  .object({
    manager: z.literal('npm'),
    registry: z.literal('https://registry.npmjs.org'),
    scripts: z.enum(['disabled', 'allow_in_isolated_copy']),
    packageCount: z.number().int().min(1).max(8),
    location: z.literal('ephemeral_isolated_work_copy'),
    status: z.enum([
      'installed_and_verification_succeeded',
      'installation_or_verification_failed',
    ]),
    hostModified: z.literal(false),
  })
  .strict();

export const dependencyPreparationErrorLabels: Record<string, string> = {
  DEPENDENCY_SOURCE_DENIED:
    '软件源或解析地址不在允许范围；请人工准备已核验的归档',
  DEPENDENCY_NETWORK_UNAVAILABLE: '软件源网络不可达，未开始安装',
  DEPENDENCY_DOWNLOAD_REJECTED: '软件源响应被拒绝（不跟随重定向），未开始安装',
  DEPENDENCY_ARCHIVE_LIMIT: '依赖归档超过 128 KiB 限额，未开始安装',
  DEPENDENCY_MANIFEST_REQUIRED: '缺少准确的 package.json 或 package-lock.json',
  DEPENDENCY_MANIFEST_INVALID: '项目或锁文件不是有效 JSON 对象',
  DEPENDENCY_LAYOUT_UNSUPPORTED: '当前仅支持有限 npm v3 锁文件布局，未开始安装',
  DEPENDENCY_LOCK_MISMATCH: '锁文件与获批的依赖版本/来源不符，需要重新审查',
  DEPENDENCY_ARCHIVE_REQUIRED: '缺少明确授权的本地归档文件',
  DEPENDENCY_INTEGRITY_MISMATCH: '依赖归档完整性校验失败，未开始安装',
};
