import { z } from 'zod';
import {
  LocalFileToolArguments,
  FileDerivationArgumentsSchema,
} from '@allrice/contracts';

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
export const localFileToolDefinitions = [
  ...(Object.keys(descriptions) as (keyof typeof descriptions)[]).map(
    (name) => ({
      name,
      description: descriptions[name],
      inputSchema: z.toJSONSchema(LocalFileToolArguments[name], {
        unrepresentable: 'any',
      }),
    }),
  ),
  {
    name: 'local.file.derive' as const,
    description:
      '在已授权电脑目录内对inspect核验的原始文件执行有界ZIP打包/列表/提取、PDF合并/页码提取/旋转，或PNG/JPEG/WebP缩放/格式转换。每次最多32个源文件、输入与解压结果合计各9000000B。路径、expected必须来自当前inspect，不能使用survey版本。request.kind=zip_pack需fileName以.zip结尾；zip_list无输出；zip_extract指定entry与单个fileName。拒绝危险路径、符号链接、加密包、重复名称、CRC错误或过度膨胀。PDF页码从1开始且唯一，旋转为90/180/270度。图片每次一个源文件，width/height为精确像素，最大8192及1600万像素；PNG/WebP保留透明，JPEG白底，只保留动画首帧，不保留EXIF/ICC。PDF拒绝加密、签名及表单，不重排正文。所有PDF/图片在固定无网络原生进程内执行，可取消；输出作为现有私有工作区附件；原文件不变，不写主机路径；另行local.file.save即可创建本机文件。',
    inputSchema: z.toJSONSchema(FileDerivationArgumentsSchema, {
      unrepresentable: 'any',
    }),
  },
];
