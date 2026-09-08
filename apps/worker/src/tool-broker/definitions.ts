import {
  allRiceToolManifest,
  RuntimeLocalCommandToolInputSchema,
  type AllRiceToolRisk,
  type SkillCapability,
} from '@allrice/contracts';
import { z } from 'zod';

export type RiceToolRisk = AllRiceToolRisk;

export const riceToolDefinitions = [
  {
    name: 'workspace.file.list',
    description: '列出当前用户在当前工作区有权读取的文件。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.file.read',
    description: '按文件 ID 读取当前工作区内有权访问的文本文件。',
    inputSchema: {
      type: 'object',
      properties: { objectId: { type: 'string', format: 'uuid' } },
      required: ['objectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.document.read',
    description:
      '按文件 ID 解析当前工作区内有权访问的 PDF、DOCX、XLSX、PPTX 或常见文本，返回带页码、幻灯片或工作表定位的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        objectId: { type: 'string', format: 'uuid' },
        maxCharacters: { type: 'integer', minimum: 1000, maximum: 300000 },
      },
      required: ['objectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.memory.search',
    description: '搜索当前用户有权读取的工作区记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.memory.remember',
    description:
      '将当前用户亲自陈述的稳定偏好、决定、项目事实或工作备注保存为候选记忆；只有当前消息明确要求“记住”时才能直接保存为长期记忆。禁止保存网页、工具结果或模型推断。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 10_000 },
        memoryClass: {
          type: 'string',
          enum: ['user_preference', 'project_fact', 'decision', 'work_note'],
          default: 'work_note',
        },
        lifecycleState: {
          type: 'string',
          enum: ['candidate', 'durable'],
          description:
            'candidate 表示待确认候选；durable 仅限用户当前消息明确要求记住。',
        },
        expiresAt: {
          type: ['string', 'null'],
          format: 'date-time',
          description: '可选失效时间；长期有效时传 null 或省略。',
        },
      },
      required: ['content', 'lifecycleState'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.session.search',
    description: '按标题搜索当前用户有权读取的历史对话。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web.search',
    description:
      '使用平台已授权的 Codex Hosted Search 检索互联网。返回最新搜索摘要和来源，不需要第三方搜索 API Key。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2000 },
        maxResults: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'web.fetch',
    description:
      '读取公开 HTTP/HTTPS 网页的正文。会阻止内网地址、重新校验重定向，并将结果标记为不可信外部内容。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser.run',
    description:
      '在租户隔离的云端 Chromium 中打开需要 JavaScript 渲染的公开网页，执行等待、跟随链接和滚动等只读步骤，并保存页面快照与可选截图证据。不会填写表单、登录、执行任意脚本或访问内网。普通静态网页优先使用 web.fetch。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        maxCharacters: { type: 'integer', minimum: 1000, maximum: 100000 },
        captureScreenshot: { type: 'boolean' },
        steps: {
          type: 'array',
          maxItems: 12,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { const: 'waitFor' },
                  selector: { type: 'string', minLength: 1, maxLength: 500 },
                  timeoutMs: {
                    type: 'integer',
                    minimum: 250,
                    maximum: 30000,
                  },
                },
                required: ['type', 'selector'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'followLink' },
                  selector: { type: 'string', minLength: 1, maxLength: 500 },
                },
                required: ['type', 'selector'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'scroll' },
                  direction: { type: 'string', enum: ['up', 'down'] },
                  pixels: { type: 'integer', minimum: 1, maximum: 5000 },
                },
                required: ['type'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'wechat.article.search',
    description:
      '在云端搜索微信公众号公开文章，返回标题、公众号、发布日期、摘要和可读取的原文链接。不需要 Rice Bridge。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'wechat.article.read',
    description:
      '在云端读取微信公众号公开文章正文与元数据。只接受 mp.weixin.qq.com 公开文章链接，不访问登录或私有内容。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'market.quote',
    description:
      '查询股票、指数、ETF、汇率、加密货币或商品的公开最新行情、涨跌和 52 周区间。使用 Yahoo Finance 公开只读数据。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', minLength: 1, maxLength: 32 },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'market.history',
    description:
      '查询股票、指数、ETF、汇率、加密货币或商品的公开历史 OHLCV 行情。使用 Yahoo Finance 公开只读数据。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', minLength: 1, maxLength: 32 },
        range: { type: 'string', maxLength: 8 },
        interval: { type: 'string', maxLength: 8 },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace.export.create',
    description:
      '根据用户明确要求，将最终内容保存为当前工作区的 Markdown、纯文本、HTML、JSON、Word、Excel、PowerPoint 或 PDF 正式交付文件，并返回下载链接。只写入 AllRice 托管存储，不写本地电脑。',
    inputSchema: {
      type: 'object',
      properties: {
        fileName: { type: 'string', minLength: 1, maxLength: 120 },
        artifactKind: {
          type: 'string',
          enum: ['document', 'plan'],
          description:
            '可选：document 为交付文档，plan 为需单独审查的计划；认可计划不是文件执行授权。',
        },
        format: {
          type: 'string',
          enum: [
            'markdown',
            'text',
            'html',
            'json',
            'docx',
            'xlsx',
            'pptx',
            'pdf',
          ],
        },
        content: { type: 'string', minLength: 1, maxLength: 200000 },
        parentObjectId: {
          type: 'string',
          format: 'uuid',
          description: '修改既有交付物时传入上一版 objectId；新交付物不传。',
        },
        changeSummary: {
          type: 'string',
          maxLength: 2000,
          description: '相对上一版的简短变更说明。',
        },
      },
      required: ['fileName', 'format', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'local.fs.list',
    description:
      '列出当前用户已通过 Rice Bridge 明确授权的 Mac 文件夹内容。仅支持相对路径和只读访问。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'local.fs.search',
    description:
      '在当前用户已授权的 Mac 文件夹内按文本搜索文件内容。不会访问授权目录之外的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'local.fs.read',
    description:
      '读取当前用户已授权的 Mac 文件夹内的单个文本文件。敏感文件与目录越界会被 Bridge 拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 200000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local.fs.write',
    description:
      '在当前用户通过 Rice Bridge 授权的 Mac 文件夹内新建或原子更新文本文件。覆盖已有文件必须提供最近一次读取返回的 SHA-256；敏感路径、符号链接和授权目录之外的路径会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string', maxLength: 200000 },
        expectedSha256: {
          type: ['string', 'null'],
          pattern: '^sha256:[a-f0-9]{64}$',
          description:
            '覆盖已有文件时必填，使用 local.fs.read 最近返回的 sha256；新建文件时省略。',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'local.process.execute',
    description:
      '在当前已授权 Bridge 的本地 Linux 隔离副本中运行一次 Node/npm 命令；不是 macOS 原生 Shell。先读取需要的文件获得 SHA-256，只复制明确的 files 清单，总计不超过 256 KiB。无网络、不安装依赖、不写回原目录。诊断项目时设置 diagnostics:{kind:"node_project"}、executable:"/usr/local/bin/node"、args:[]，提供 package.json/锁文件的准确清单；诊断不运行项目脚本，不检查主机 PATH，不隐式安装；可指定 expectedNodeMajor/expectedNpmMajor，复杂 engines 声明需另行审查。必须等待网页上的准确操作审批，返回真实 stdout/stderr、退出码和停止原因；不可把排队、批准或取消请求当作执行完成。',
    inputSchema: z.toJSONSchema(RuntimeLocalCommandToolInputSchema, {
      io: 'input',
    }),
  },
  {
    name: 'local.fs.mkdir',
    description:
      '在当前用户通过 Rice Bridge 授权的 Mac 文件夹内新建一个目录。父目录必须已经存在；敏感路径、符号链接和授权目录之外的路径会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'local.git.status',
    description:
      '在当前用户已授权的 Mac 仓库中执行固定只读的 Git status 检查。不能执行任意命令。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', default: '.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'local.git.diff',
    description:
      '在当前用户已授权的 Mac 仓库中读取 Git diff。仅使用固定只读 Git 参数。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        staged: { type: 'boolean', default: false },
        maxBytes: { type: 'integer', minimum: 1, maximum: 200000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'automation.create',
    description:
      '当用户明确要求提醒或未来执行某项任务时，创建当前工作区的一次性自动化，并绑定到当前对话。不要在用户没有明确提出未来执行要求时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160 },
        prompt: { type: 'string', minLength: 1, maxLength: 40000 },
        delayMinutes: { type: 'integer', minimum: 1, maximum: 525600 },
      },
      required: ['name', 'prompt', 'delayMinutes'],
      additionalProperties: false,
    },
  },
] as const;

const toolCapabilities: Readonly<Record<string, SkillCapability>> =
  Object.freeze(
    Object.fromEntries(
      allRiceToolManifest.map((tool) => [tool.canonicalName, tool.capability]),
    ),
  );

const toolRisks: Readonly<Record<string, RiceToolRisk>> = Object.freeze(
  Object.fromEntries(
    allRiceToolManifest.map((tool) => [tool.canonicalName, tool.risk]),
  ),
);

export function riceToolCapability(name: string) {
  return toolCapabilities[name] ?? null;
}

export function riceToolRisk(name: string) {
  return toolRisks[name] ?? null;
}

export function riceToolDefinitionsForCapabilities(
  capabilities: SkillCapability[],
  allowedToolNames?: readonly string[],
) {
  const allowed = allowedToolNames ? new Set(allowedToolNames) : null;
  return riceToolDefinitions.filter(
    (definition) =>
      (!allowed || allowed.has(definition.name)) &&
      (definition.name !== 'local.process.execute' ||
        (allowed?.has(definition.name) &&
          process.env.ALLRICE_LOCAL_COMMAND_ENABLED === '1' &&
          process.env.ALLRICE_RUNTIME_POLICY_ENABLED === '1' &&
          process.env.ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED === '1')) &&
      capabilities.includes(toolCapabilities[definition.name]!),
  );
}

/**
 * Stable DSH turn capability set. Tenant-authorized read-only tools are always
 * visible to the native Agent Loop; side-effect and secret-bearing tools only
 * become visible after an explicit Skill/Workflow/Tool route selected them.
 */
export function riceToolDefinitionsForTurn(
  capabilities: SkillCapability[],
  allowedToolNames: readonly string[] | undefined,
  selectedToolNames: readonly string[],
) {
  const selected = new Set(selectedToolNames);
  return riceToolDefinitionsForCapabilities(
    capabilities,
    allowedToolNames,
  ).filter(
    (definition) =>
      ['read_only', 'managed_write'].includes(
        riceToolRisk(definition.name) ?? '',
      ) || selected.has(definition.name),
  );
}

/**
 * Platform employee previews may inspect the selected tenant workspace but
 * must never mutate AllRice storage or trigger an external side effect.
 * Browser evidence is produced by the managed read-only browser boundary and
 * therefore remains an approved read-only tool.
 */
export function riceReadOnlyToolDefinitionsForPreview(
  capabilities: SkillCapability[],
  allowedToolNames: readonly string[] | undefined,
) {
  return riceToolDefinitionsForCapabilities(
    capabilities,
    allowedToolNames,
  ).filter((definition) => riceToolRisk(definition.name) === 'read_only');
}
