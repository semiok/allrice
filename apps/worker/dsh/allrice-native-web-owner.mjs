import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'allrice-native-web-owner';
export const inject = ['connection', 'webServer'];

/** Native local login only. This file never establishes an AllRice principal. */
export async function apply(ctx, config) {
  const { artifactPath, nonce, baseUrl } = config;
  const temporary = `${artifactPath}.${randomUUID()}.tmp`;
  const owned = ctx.effect(async () => {
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          v: 1,
          nonce,
          authenticatedUrl: ctx.connection.authenticatedUrl(baseUrl),
        }),
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, artifactPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return () => rm(artifactPath, { force: true });
  }, 'allrice native local auth publication');
  await owned;
}
