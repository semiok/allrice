import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { McpBearerSchema } from './mcp.ts';

export const MCP_APPS = {
  github: {
    name: 'GitHub',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    description: '查看代码仓库、Issue 和 PR，协助开发与代码审查。',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
  },
  linear: {
    name: 'Linear',
    endpoint: 'https://mcp.linear.app/mcp',
    description: '查找、创建和更新任务，跟进项目与工作进度。',
    tokenUrl: 'https://linear.app/settings/api',
  },
} as const;
export const McpAppIdSchema = z.enum(['github', 'linear']);
export type McpAppId = z.infer<typeof McpAppIdSchema>;
export const ConnectMcpAppSchema = z.discriminatedUnion('method', [
  z
    .object({
      workspaceId: UuidSchema,
      appId: McpAppIdSchema,
      method: z.literal('oauth'),
    })
    .strict(),
  z
    .object({
      workspaceId: UuidSchema,
      appId: McpAppIdSchema,
      method: z.literal('token'),
      bearerToken: McpBearerSchema,
    })
    .strict(),
]);
export const GITHUB_MCP_CALLBACK_PATH = '/api/v1/connections/github/callback';
export const GithubMcpSettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  clientId: z.string(),
  callbackUrl: z.string(),
  secretConfigured: z.boolean(),
  ready: z.boolean(),
});
export type GithubMcpSettings = z.infer<typeof GithubMcpSettingsSchema>;
export const UpdateGithubMcpSettingsSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    clientId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{8,200}$/),
    clientSecret: z
      .string()
      .regex(/^[\x21-\x7e]{8,4096}$/)
      .optional(),
    callbackUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === GITHUB_MCP_CALLBACK_PATH
        );
      }),
  })
  .strict();
