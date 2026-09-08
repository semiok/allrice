import { z } from 'zod';

/** A diagnostic request is not an arbitrary program, installer or host scan. */
export const RuntimeProjectDiagnosticsRequestSchema = z
  .object({
    kind: z.literal('node_project'),
    expectedNodeMajor: z.number().int().min(1).max(100).optional(),
    expectedNpmMajor: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const RuntimeProjectDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    target: z.literal('local_linux_isolated_copy'),
    hostToolchain: z.literal('not_inspected'),
    platform: z.literal('linux'),
    architecture: z.enum(['x64', 'arm64']),
    directory: z.string().max(1100),
    node: z
      .object({
        path: z.literal('/usr/local/bin/node'),
        version: z.string().regex(/^v\d+\.\d+\.\d+$/),
        status: z.enum(['available', 'version_mismatch']),
      })
      .strict(),
    npm: z
      .object({
        path: z.literal('/usr/local/bin/npm'),
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .nullable(),
        status: z.enum(['available', 'not_installed', 'version_mismatch']),
      })
      .strict(),
    project: z.enum(['available', 'manifest_missing', 'manifest_invalid']),
    packageManager: z.enum(['npm', 'pnpm', 'yarn', 'unknown']),
    lockfile: z.enum([
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'missing',
      'multiple',
    ]),
    dependencies: z.enum(['none_declared', 'not_prepared', 'unknown']),
    nodeEngine: z.string().max(100).nullable(),
    engineStatus: z.enum(['not_declared', 'requires_review']),
    network: z.literal('disabled'),
    installedOrRepaired: z.literal(false),
  })
  .strict();
export type RuntimeProjectDiagnostics = z.infer<
  typeof RuntimeProjectDiagnosticsSchema
>;

export const projectDiagnosticLabels: Record<string, string> = {
  available: '可用',
  version_mismatch: '版本不符',
  not_installed: '未安装',
  manifest_missing: '未提供 package.json',
  manifest_invalid: '项目清单无效',
  none_declared: '未声明依赖',
  not_prepared: '隔离副本的依赖尚未准备',
  unknown: '未知',
  missing: '未提供锁文件',
  multiple: '存在多个锁文件，需确认工具链',
};
