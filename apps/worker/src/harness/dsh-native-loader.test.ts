import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads the measured current-platform binary from the helper rather than a public old-generation hoist', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {readFileSync} from 'node:fs';
    import {dirname,join} from 'node:path';
    import {createHash} from 'node:crypto';
    const worker=createRequire(process.cwd()+'/apps/worker/package.json');
    const cordis=createRequire(worker.resolve('@deepseek-ai/cordis-plugin-loader'));
    const entry=createRequire(cordis.resolve('node-addon-require-builtin'));
    const helper=createRequire(entry.resolve('node-addon-native-custom-loader'));
    const info=cordis('node-addon-require-builtin').getBindingInfo();
    assert.equal(entry('node-addon-require-builtin/package.json').version,'0.1.9');
    const pkg=dirname(helper.resolve(info.optionalPackageName));
    assert.equal(JSON.parse(readFileSync(join(pkg,'package.json'))).version,'0.1.9');
    const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(hash(info.bindingPath),hash(join(pkg,info.optionalBinaryRelativePath)));
    assert.ok(cordis('node-addon-require-builtin').requireBuiltin('internal/modules/esm/loader'));
    console.log(JSON.stringify({passed:true,platformPackage:info.optionalPackageName,version:'0.1.9'}));
  `,
    ],
    { cwd: root, encoding: 'utf8', timeout: 15000 },
  );
  expect(JSON.parse(result)).toMatchObject({ passed: true, version: '0.1.9' });
});
