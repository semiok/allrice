import { z } from 'zod';
import { RuntimeNpmPackageSchema } from './runtime-v2/dependency-preparation.ts';

/** Declarations only: no source directory, URL, registry config or executable.
 * Resolution creates a new immutable project version, never changes an old one. */
const npm = RuntimeNpmPackageSchema.pick({ name: true, version: true });
const python = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    version: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[0-9][A-Za-z0-9.!+_-]*$/),
  })
  .strict();
export const ProjectDependencyResolveInputSchema = z
  .discriminatedUnion('manager', [
    z
      .object({
        action: z.literal('resolve'),
        manager: z.literal('pnpm'),
        packages: z.array(npm).min(1).max(32),
        resourceProfile: z
          .enum(['standard', 'web-development'])
          .default('standard'),
      })
      .strict(),
    z
      .object({
        action: z.literal('resolve'),
        manager: z.literal('uv'),
        packages: z.array(python).min(1).max(32),
        /** CPU of the Linux environment that will install the lock. Omitted: the
         * server's. Set for a machine whose CPU differs from the server's. */
        architecture: z.enum(['amd64', 'arm64']).optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const names = value.packages.map((p) =>
      value.manager === 'uv'
        ? p.name.toLowerCase().replace(/[-_.]+/g, '-')
        : p.name,
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate dependency declaration',
      });
  });
export type ProjectDependencyResolveInput = z.infer<
  typeof ProjectDependencyResolveInputSchema
>;

export function projectResolutionManifest(
  input: ProjectDependencyResolveInput,
) {
  const a = ProjectDependencyResolveInputSchema.parse(input);
  const packages = [...a.packages].sort((a, b) => a.name.localeCompare(b.name));
  return a.manager === 'pnpm'
    ? {
        path: 'package.json',
        text:
          JSON.stringify(
            {
              name: 'allrice-managed-project',
              private: true,
              packageManager: 'pnpm@10.33.3',
              dependencies: Object.fromEntries(
                packages.map((p) => [p.name, p.version]),
              ),
            },
            null,
            2,
          ) + '\n',
      }
    : {
        path: 'requirements.in',
        text: packages.map((p) => `${p.name}==${p.version}`).join('\n') + '\n',
      };
}
export const projectResolutionLimits = Object.freeze({
  tmpMiB: 256,
  lockBytes: 200_000,
  packageCount: 128,
  webPackageCount: 256,
  receiptBytes: 512_000,
  diagnosticsBytes: 16_384,
});

/** Resolution is not evidence that installation or business execution passed. */
export const ProjectDependencyResolutionReceiptSchema = z
  .object({
    version: z.literal(1),
    manager: z.enum(['pnpm', 'uv']),
    phase: z.enum(['manager_download', 'resolve', 'lock_validation']),
    status: z.enum(['resolved', 'failed']),
    exitCode: z.number().int().min(0).max(255),
    errorCode: z
      .enum([
        'PROJECT_RESOLUTION_DOWNLOAD_FAILED',
        'PROJECT_RESOLUTION_TOOL_INTEGRITY',
        'PROJECT_RESOLUTION_PACKAGE_FAILED',
        'PROJECT_RESOLUTION_LOCK_UNSUPPORTED',
        'PROJECT_RESOLUTION_LIMIT',
        'PROJECT_RESOLUTION_INTERNAL',
      ])
      .optional(),
    diagnostics: z.string().max(projectResolutionLimits.diagnosticsBytes),
    lock: z.string().max(projectResolutionLimits.lockBytes).optional(),
    wheels: z
      .array(
        z
          .object({
            name: python.shape.name,
            version: python.shape.version,
            fileName: z.string().max(200),
            url: z.string().max(1024),
            sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((r, c) => {
    if (
      r.status === 'resolved'
        ? r.exitCode !== 0 ||
          !r.lock ||
          !!r.errorCode ||
          r.phase !== 'lock_validation'
        : r.exitCode === 0 ||
          !r.errorCode ||
          r.lock !== undefined ||
          r.wheels !== undefined
    )
      c.addIssue({
        code: 'custom',
        message: 'resolution receipt outcome mismatch',
      });
  });
export type ProjectDependencyResolutionReceipt = z.infer<
  typeof ProjectDependencyResolutionReceiptSchema
>;

/** The public ledger summary is exact JSON. Keep large lock material only in
 * the private execution receipt; undefined fields cannot be canonically hashed. */
export function projectResolutionReceiptSummary(
  receipt: ProjectDependencyResolutionReceipt,
) {
  return {
    version: receipt.version,
    manager: receipt.manager,
    phase: receipt.phase,
    status: receipt.status,
    exitCode: receipt.exitCode,
    diagnostics: receipt.diagnostics,
    ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
  };
}

export function projectResolutionErrorMessage(code: string | undefined) {
  const messages: Record<string, string> = {
    PROJECT_RESOLUTION_DOWNLOAD_FAILED: '依赖工具下载未完成，请查看诊断记录。',
    PROJECT_RESOLUTION_TOOL_INTEGRITY: '下载文件校验未通过，已停止准备。',
    PROJECT_RESOLUTION_PACKAGE_FAILED:
      '依赖解析失败，请核对包名、版本和诊断记录。',
    PROJECT_RESOLUTION_LOCK_UNSUPPORTED:
      '当前依赖无法生成受支持的锁文件，未开始安装。',
    PROJECT_RESOLUTION_LIMIT: '依赖规模超过当前环境的上限，未开始安装。',
    PROJECT_RESOLUTION_INTERNAL: '依赖准备未完成，已保留具体错误供排查。',
  };
  return code ? messages[code] : undefined;
}
