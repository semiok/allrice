import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { readPublicGitHubSource } from './personal-skill-github.ts';
import { parsePersonalSkillGitHubUrl as parseSourceUrl } from '@allrice/contracts';
const { Response, ReadableStream, AbortController } = globalThis;

const commit = 'a'.repeat(40),
  treeSha = 'b'.repeat(40);
const definition = Buffer.from(
  '---\nname: weekly\ndescription: Synthetic weekly report.\n---\nRead references/rules.md.',
);
const rule = Buffer.from('Synthetic rule: count records exactly.\n');
const hash = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
function setup({
  directory = 'weekly',
  changeTree,
  override,
  refs = ['main', commit],
  contents,
} = {}) {
  const fileMap = new Map(
    contents ?? [
      [directory + '/SKILL.md', definition],
      [directory + '/references/rules.md', rule],
    ],
  );
  const tree = [
    { path: directory, mode: '040000', type: 'tree', sha: 'c'.repeat(40) },
    {
      path: directory + '/references',
      mode: '040000',
      type: 'tree',
      sha: 'd'.repeat(40),
    },
    ...[...fileMap].map(([path, bytes]) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha: hash(bytes),
      size: bytes.length,
    })),
  ];
  changeTree?.(tree);
  const requests = [];
  const json = (data) =>
    new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json' },
    });
  async function fetch(address, options) {
    requests.push({ address, options });
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    assert.ok(
      !Object.keys(options.headers).some((k) =>
        /authorization|cookie/i.test(k),
      ),
    );
    if (override) {
      const result = await override(address, options, { tree, fileMap, json });
      if (result) return result;
    }
    const url = new URL(address);
    if (url.hostname === 'raw.githubusercontent.com') {
      assert.equal(
        url.pathname.split('/')[3],
        commit,
        'content must use immutable commit, never moving branch',
      );
      const path = url.pathname
        .split('/')
        .slice(4)
        .map(decodeURIComponent)
        .join('/');
      return fileMap.has(path)
        ? new Response(fileMap.get(path))
        : new Response(null, { status: 404 });
    }
    assert.equal(url.hostname, 'api.github.com');
    if (url.pathname === '/repos/acme/skills')
      return json({
        private: false,
        full_name: 'acme/skills',
        default_branch: 'main',
      });
    if (url.pathname.startsWith('/repos/acme/skills/commits/')) {
      const ref = decodeURIComponent(
        url.pathname.slice('/repos/acme/skills/commits/'.length),
      );
      return refs.includes(ref)
        ? json({ sha: commit, commit: { tree: { sha: treeSha } } })
        : new Response(
            JSON.stringify({
              message: `No commit found for SHA: ${ref}`,
              status: '422',
            }),
            { status: 422 },
          );
    }
    if (url.pathname === `/repos/acme/skills/git/trees/${treeSha}`)
      return json({ sha: treeSha, truncated: false, tree });
    assert.fail('Unexpected URL: ' + address);
  }
  return { fetch, requests, tree, fileMap };
}
const fail = (code) => (error) => error.code === code;
const root = 'https://github.com/acme/skills';

test('repository, directory and literal SKILL.md links yield identical exact package bytes', async () => {
  const results = [];
  for (const url of [
    root,
    root + '/tree/main/weekly',
    root + `/blob/${commit}/weekly/SKILL.md`,
  ]) {
    const fixture = setup();
    const result = await readPublicGitHubSource(url, fixture);
    assert.equal(result.provenance.commitSha, commit);
    assert.deepEqual(result.provenance.license, { status: 'unknown' });
    assert.equal(result.credentialsUsed, false);
    assert.equal(result.codeExecuted, false);
    assert.equal(result.files.length, 2);
    results.push(result.files);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

test('unsafe authority, URL credentials, traversal and encoded path separators are refused before IO', async () => {
  for (const url of [
    root.replace('https:', 'http:'),
    root.replace('github.com', 'github.com.evil.test'),
    root.replace('github.com', 'secret@github.com'),
    root + '?token=secret',
    root + '#fragment',
    root + '/tree/main/%2e%2e/weekly',
    root + '/tree/main/../weekly',
    root + '/tree/main%2Fweekly',
    root + '/blob/main/README.md',
    root + '/tree/main/%00',
    root + '\\tail',
    root + '/tree/main/%ZZ',
    root + '/tree/main/weekly#',
    root + '/tree/main/weekly?',
  ]) {
    const fixture = setup();
    await assert.rejects(
      readPublicGitHubSource(url, fixture),
      fail('source_url_invalid'),
    );
    assert.equal(fixture.requests.length, 0);
  }
  assert.equal(parseSourceUrl(root + '/').kind, 'repository');
});

test('encoded hash remains an exact filename, while a bare URL fragment cannot change the path', async () => {
  const fixture = setup({ directory: 'weekly#' });
  const result = await readPublicGitHubSource(
    root + '/tree/main/weekly%23',
    fixture,
  );
  assert.equal(result.provenance.sourcePath, 'weekly#');
  assert.deepEqual(result.candidatePaths, ['weekly#/SKILL.md']);
});

test('SKILL.md template resources are preserved but never added to explicit candidate paths', async () => {
  const contents = [
    ['weekly/SKILL.md', definition],
    ...Array.from({ length: 8 }, (_, n) => [
      `weekly/assets/template${n}/SKILL.md`,
      Buffer.from(`Template ${n}`),
    ]),
  ];
  for (const url of [root, root + `/blob/${commit}/weekly/SKILL.md`]) {
    const result = await readPublicGitHubSource(url, setup({ contents }));
    assert.equal(result.files.length, 9);
    assert.deepEqual(result.candidatePaths, ['weekly/SKILL.md']);
    assert.deepEqual(
      result.files.find((file) => file.path.includes('template7')).bytes,
      Buffer.from('Template 7'),
    );
  }
});

test('archive file limit is preserved, without widening existing Bridge or storage bounds', async () => {
  const contents = [
    ['weekly/SKILL.md', definition],
    ...Array.from({ length: 32 }, (_, n) => [
      `weekly/assets/template${n}.txt`,
      Buffer.from(`Template ${n}`),
    ]),
  ];
  const fixture = setup({ contents });
  await assert.rejects(
    readPublicGitHubSource(root, fixture),
    fail('source_archive_file_limit'),
  );
  assert.ok(
    fixture.requests.every(
      (r) => !r.address.includes('raw.githubusercontent.com'),
    ),
  );
});

test('unique slash-containing branch resolves exactly; ambiguous branch/path is not guessed', async () => {
  const fixture = setup({ refs: ['feature/work'] });
  const result = await readPublicGitHubSource(
    root + '/tree/feature/work/weekly',
    fixture,
  );
  assert.equal(result.provenance.resolvedRef, 'feature/work');
  assert.equal(result.provenance.sourcePath, 'weekly');
  const ambiguous = setup({ refs: ['main', 'main/weekly'] });
  await assert.rejects(
    readPublicGitHubSource(root + '/tree/main/weekly', ambiguous),
    fail('source_ref_ambiguous'),
  );
  assert.ok(
    ambiguous.requests.every(
      (r) => !r.address.includes('raw.githubusercontent.com'),
    ),
  );
});

test('wrong commit identity, renamed repository, or private repository is rejected', async () => {
  for (const [path, value, code] of [
    [
      '/commits/',
      { sha: 'f'.repeat(40), commit: { tree: { sha: treeSha } } },
      'source_commit_identity_invalid',
    ],
    [
      '/repos/acme/skills',
      { private: false, full_name: 'acme/moved' },
      'source_repository_identity_invalid',
    ],
    [
      '/repos/acme/skills',
      { private: true, full_name: 'acme/skills' },
      'source_repository_identity_invalid',
    ],
  ]) {
    const fixture = setup({
      override: (address, _, { json }) =>
        (
          path === '/commits/'
            ? address.includes(path)
            : new URL(address).pathname === path
        )
          ? json(value)
          : null,
    });
    await assert.rejects(
      readPublicGitHubSource(root + `/tree/${commit}/weekly`, fixture),
      fail(code),
    );
  }
});

test('only the exact observed missing-commit 422 is treated as a nonexistent reference', async () => {
  const fixture = setup({
    override: (address) =>
      address.includes('/commits/')
        ? new Response(
            JSON.stringify({ message: 'Validation Failed', status: '422' }),
            { status: 422 },
          )
        : null,
  });
  await assert.rejects(
    readPublicGitHubSource(root, fixture),
    fail('source_reference_invalid'),
  );
  assert.equal(fixture.requests.length, 2);
  const missing = setup({
    override: (address) =>
      address.includes('/commits/')
        ? new Response(null, { status: 404 })
        : null,
  });
  await assert.rejects(
    readPublicGitHubSource(root, missing),
    fail('source_not_found'),
  );
});

test('truncated or oversized tree discovery never creates a partial package', async () => {
  for (const result of [
    { sha: treeSha, truncated: true, tree: [] },
    {
      sha: treeSha,
      truncated: false,
      tree: Array.from({ length: 10001 }, (_, n) => ({
        path: `f${n}`,
        mode: '100644',
        type: 'blob',
        sha: 'c'.repeat(40),
        size: 0,
      })),
    },
  ]) {
    const fixture = setup({
      override: (url, _, { json }) =>
        url.includes('/git/trees/') ? json(result) : null,
    });
    await assert.rejects(
      readPublicGitHubSource(root, fixture),
      fail(result.truncated ? 'source_tree_incomplete' : 'source_tree_limit'),
    );
    assert.ok(
      fixture.requests.every(
        (r) => !r.address.includes('raw.githubusercontent.com'),
      ),
    );
  }
});

test('case aliases and traversal in metadata fail before downloading any resource', async () => {
  for (const path of ['weekly/skill.MD', 'weekly/../outside']) {
    const fixture = setup({
      changeTree: (tree) => tree.push({ ...tree[2], path }),
    });
    await assert.rejects(
      readPublicGitHubSource(root, fixture),
      fail(
        path.includes('..') ? 'source_path_invalid' : 'source_path_conflict',
      ),
    );
    assert.ok(
      fixture.requests.every(
        (r) => !r.address.includes('raw.githubusercontent.com'),
      ),
    );
  }
});

test('candidate symlinks, resource symlinks and submodules are not dereferenced', async () => {
  for (const [index, mode, type] of [
    [2, '120000', 'blob'],
    [3, '120000', 'blob'],
    [3, '160000', 'commit'],
    [1, '120000', 'blob'],
  ]) {
    const fixture = setup({
      changeTree: (tree) => Object.assign(tree[index], { mode, type }),
    });
    await assert.rejects(
      readPublicGitHubSource(root, fixture),
      fail('source_link_unsupported'),
    );
    assert.ok(
      fixture.requests.every(
        (r) => !r.address.includes('raw.githubusercontent.com'),
      ),
    );
  }
});

test('per-file and per-package resource limits are checked before downloading', async () => {
  for (const [changeTree, code] of [
    [
      (tree) => {
        tree[2].size = 262145;
      },
      'source_too_large',
    ],
    [
      (tree) => {
        tree[3].size = 131073;
      },
      'source_too_large',
    ],
    [
      (tree) => {
        for (let n = 0; n < 32; n++)
          tree.push({ ...tree[3], path: `weekly/assets/x${n}` });
      },
      'source_resource_limit',
    ],
    [
      (tree) => {
        tree[3].size = 131072;
        for (let n = 0; n < 4; n++)
          tree.push({ ...tree[3], path: `weekly/assets/x${n}` });
      },
      'source_resource_limit',
    ],
  ]) {
    const fixture = setup({ changeTree });
    await assert.rejects(readPublicGitHubSource(root, fixture), fail(code));
    assert.ok(
      fixture.requests.every(
        (r) => !r.address.includes('raw.githubusercontent.com'),
      ),
    );
  }
});

test('body length and Git blob identity independently reject incomplete or changed bytes', async () => {
  for (const bytes of [
    Buffer.from('wrong'),
    Buffer.alloc(definition.length, 'x'),
  ]) {
    const fixture = setup({
      override: (url) =>
        url.includes('raw.githubusercontent.com') && url.endsWith('SKILL.md')
          ? new Response(bytes)
          : null,
    });
    await assert.rejects(
      readPublicGitHubSource(root, fixture),
      fail('source_blob_identity_invalid'),
    );
  }
});

test('Git LFS pointer is not mistaken for the original reference file', async () => {
  const pointer = Buffer.from(
    'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1234\n',
  );
  const fixture = setup({
    contents: [
      ['weekly/SKILL.md', definition],
      ['weekly/references/rules.md', pointer],
    ],
  });
  await assert.rejects(
    readPublicGitHubSource(root, fixture),
    fail('source_lfs_unsupported'),
  );
});

test('redirect and rate-limit failures stay distinct and make no retry or credential fallback', async () => {
  for (const [status, code] of [
    [302, 'source_redirect_unsupported'],
    [403, 'source_access_or_rate_limited'],
    [429, 'source_access_or_rate_limited'],
    [500, 'source_unavailable'],
  ]) {
    const fixture = setup({
      override: () =>
        new Response(null, {
          status,
          headers: { location: 'http://127.0.0.1' },
        }),
    });
    await assert.rejects(readPublicGitHubSource(root, fixture), fail(code));
    assert.equal(fixture.requests.length, 1);
  }
});

test('stream byte bound applies even when Content-Length is absent', async () => {
  const fixture = setup({
    override: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1000000));
            controller.enqueue(new Uint8Array(1000001));
            controller.close();
          },
        }),
      ),
  });
  await assert.rejects(
    readPublicGitHubSource(root, fixture),
    fail('source_too_large'),
  );
  assert.equal(fixture.requests.length, 1);
});

test('caller cancellation stops work before starting IO', async () => {
  const fixture = setup(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readPublicGitHubSource(root, { ...fixture, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(fixture.requests.length, 0);
});

test('multiple candidates remain separate without selecting or executing either', async () => {
  const fixture = setup({
    contents: [
      ['weekly/SKILL.md', definition],
      ['daily/SKILL.md', Buffer.from('---\nname: daily\n---\nSynthetic')],
    ],
  });
  const result = await readPublicGitHubSource(root, fixture);
  assert.equal(
    result.files.filter((file) => file.path.endsWith('SKILL.md')).length,
    2,
  );
  assert.equal(result.codeExecuted, false);
});
