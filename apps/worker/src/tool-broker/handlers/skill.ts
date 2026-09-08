import { z } from 'zod';
import { SkillResourcePathSchema } from '@allrice/contracts';
import { readFrozenSkillResource } from '@allrice/database';
import type { RiceToolHandler } from '../types.js';

export const readSkillResource: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  const query = z
    .object({
      skill: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      path: SkillResourcePathSchema,
    })
    .strict()
    .parse(args);
  const resource = readFrozenSkillResource(
    input.nativeSkills ?? [],
    query.skill,
    query.path,
  );
  const { contentBase64, ...metadata } = resource;
  const text = /^(text\/|application\/(json|javascript)$)/.test(
    resource.mediaType,
  );
  return {
    modelContent: JSON.stringify({
      ...metadata,
      ...(text
        ? {
            text: new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.from(contentBase64, 'base64'),
            ),
          }
        : { contentBase64 }),
      executionPermission: false,
    }),
    summary: `已读取 ${query.skill}@${resource.version} / ${query.path}（仅资源，未执行）`,
  };
};
