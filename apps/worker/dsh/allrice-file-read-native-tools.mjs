import { z } from 'zod';

const argsSchema = z
  .object({
    objectId: z.uuid(),
    offset: z.number().int().min(0).max(2_000_000).optional(),
    limit: z.number().int().min(1).max(4_000).optional(),
  })
  .strict();

export const fileReadNativeTools = [
  {
    canonicalName: 'workspace.file.read',
    wireName: 'workspace_file_read',
    description:
      '按文件 ID 分页读取本工作区获权文本文件（含工具结果）；offset 为字符偏移，按 nextOffset 续读，勿重复加载全文。',
    parameters: {
      objectId: {
        type: 'string',
        required: true,
        description: 'Exact authorized file UUID.',
      },
      offset: {
        type: 'integer',
        description: 'Character offset, 0 to 2000000. Default 0.',
      },
      limit: {
        type: 'integer',
        description: 'Character count, 1 to 4000. Default 4000.',
      },
    },
    validateArguments(args) {
      return argsSchema.parse(args);
    },
  },
];
