import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandToolInputSchema,
} from '@allrice/contracts';
import {
  candidateCommand,
  change,
  checksum,
} from '../test/command-candidate.fixture.js';
import { readLocalCommandInputs } from './local-command-inputs.js';

const roots: string[] = [];
const before = 'throw Error("old source");';
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'allrice-candidate-unit-'));
  roots.push(root);
  await writeFile(join(root, 'test.mjs'), before);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it('stages modified/new/deleted files and binds the entire exact resulting manifest without writing the host', async () => {
  const root = await setup();
  await writeFile(join(root, 'old.txt'), 'remove');
  const command = candidateCommand(
    [
      change('test.mjs', before, 'new'),
      change('old.txt', 'remove', null),
      change('src/new.txt', null, 'added'),
    ],
    [
      { path: 'test.mjs', sha256: checksum(before) },
      { path: 'old.txt', sha256: checksum('remove') },
    ],
  );
  const result = await readLocalCommandInputs(root, command);
  expect(
    result.files.map((f) => [
      f.path,
      Buffer.from(f.content, 'base64').toString(),
    ]),
  ).toEqual([
    ['src/new.txt', 'added'],
    ['test.mjs', 'new'],
  ]);
  expect(result.candidate?.inputDigest).toBe(
    checksum(
      JSON.stringify([
        ['src/new.txt', checksum('added')],
        ['test.mjs', checksum('new')],
      ]),
    ),
  );
  expect(await readFile(join(root, 'test.mjs'), 'utf8')).toBe(before);
  expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('remove');
  await expect(readFile(join(root, 'src/new.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it.each([
  'bad_object',
  'bad_file',
  'missing_before',
  'case_alias',
  'prefix',
  'sensitive',
  'oversized',
])('rejects invalid candidate %s before execution', async (scenario) => {
  const root = await setup();
  const files = [change('test.mjs', before, 'new')];
  if (scenario === 'bad_file') files[0]!.after!.checksum = checksum('other');
  if (scenario === 'missing_before') files[0]!.before = null;
  if (scenario === 'case_alias') files.push(change('TEST.mjs', null, 'alias'));
  if (scenario === 'prefix')
    files.push(change('test.mjs/nested', null, 'alias'));
  if (scenario === 'sensitive') files.push(change('.env', null, 'secret'));
  if (scenario === 'oversized')
    files.push(
      change('big1', null, 'x'.repeat(140000)),
      change('big2', null, 'x'.repeat(140000)),
    );
  const command = candidateCommand(files);
  if (scenario === 'bad_object')
    command.arguments.candidate!.checksum = checksum('bad');
  await expect(readLocalCommandInputs(root, command)).rejects.toThrow();
  expect(await readFile(join(root, 'test.mjs'), 'utf8')).toBe(before);
});
it.each(['existing', 'dangling_link', 'parent_link', 'source_changed'])(
  'preserves user filesystem changes: %s',
  async (scenario) => {
    const root = await setup();
    const command = candidateCommand([
      change('test.mjs', before, 'new'),
      change('nested/new', null, 'added'),
    ]);
    if (scenario === 'parent_link') await symlink('/tmp', join(root, 'nested'));
    else {
      await mkdir(join(root, 'nested'));
      if (scenario === 'existing')
        await writeFile(join(root, 'nested/new'), 'user');
      if (scenario === 'dangling_link')
        await symlink('/missing-fixture-target', join(root, 'nested/new'));
      if (scenario === 'source_changed')
        await writeFile(join(root, 'test.mjs'), 'user edit');
    }
    await expect(readLocalCommandInputs(root, command)).rejects.toThrow();
  },
);
it('does not accept model-authored bytes, authority or mixed execution modes', () => {
  const command = candidateCommand([change('test.mjs', before, 'new')]);
  const {
    executable,
    args: argv,
    path,
    files,
    limits,
    candidate,
  } = command.arguments;
  const args = { executable, args: argv, path, files, limits, candidate };
  expect(RuntimeLocalCommandToolInputSchema.safeParse(args).success).toBe(
    false,
  );
  const ref = {
    artifactId: args.candidate!.artifactId,
    checksum: args.candidate!.checksum,
  };
  expect(
    RuntimeLocalCommandToolInputSchema.safeParse({ ...args, candidate: ref })
      .success,
  ).toBe(true);
  expect(
    RuntimeLocalCommandSchema.safeParse({
      ...command,
      arguments: {
        ...command.arguments,
        diagnostics: { kind: 'node_project' },
      },
    }).success,
  ).toBe(false);
});
