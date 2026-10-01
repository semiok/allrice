import { z } from 'zod';
import { LocalFileToolArguments } from '@allrice/contracts';

const descriptions = {
  'local.file.inspect':
    '核验已授权电脑目录内的文件，返回内容checksum与实际文件版本；不上传字节。',
  'local.file.import':
    '将用户选定且已核验版本的电脑文件原始字节上传为现有工作区附件；先inspect取得expected，文件变化必须重新确认，不得违背用户不上传要求。',
  'local.file.save':
    '按objectId与checksum保存平台文件原始字节到已授权电脑目录；create-only，重名必须改名，不会静默覆盖。返回真实落盘证据，平台文件与本机保存状态分别报告。',
  'local.file.open':
    '用电脑默认应用打开已核验版本的文档或图片；expected来自inspect或save。文件变化必须重新确认，不允许应用、脚本或可执行文件。只说明系统接收打开动作，不声称用户已读。',
  'local.file.reveal':
    '在Finder定位已核验版本的文档或图片；expected来自inspect或save，不允许任意绝对路径。',
} as const;
export const localFileToolDefinitions = (
  Object.keys(descriptions) as (keyof typeof descriptions)[]
).map((name) => ({
  name,
  description: descriptions[name],
  inputSchema: z.toJSONSchema(LocalFileToolArguments[name], {
    unrepresentable: 'any',
  }),
}));
