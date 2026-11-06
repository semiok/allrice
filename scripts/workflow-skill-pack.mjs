#!/usr/bin/env -S node --import tsx
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import {
  EmployeeContentReferenceSchema,
  EmployeeContentTextSchema,
  EmployeeSceneSkillPayloadSchema,
} from '../packages/contracts/src/employee-content.ts';
import { personalSkillLimits } from '../packages/contracts/src/personal-skills.ts';
import { PersonalSceneFileSchema } from '../packages/contracts/src/personal-scene-files.ts';
import { SkillBundleSchema } from '../packages/contracts/src/skill-bundle.ts';
import {
  WorkflowSkillFrontmatterSchema,
  workflowSkillInvalidMessage,
} from '../packages/contracts/src/workflow-skill.ts';
import { allRiceToolManifest } from '../packages/contracts/src/tool-manifest.ts';
import {
  skillBundleChecksum,
  skillBytesChecksum,
  validateSkillBundle,
} from '../packages/database/src/skill-bundles.ts';
import { validateSceneSkillPackage } from '../packages/database/src/employees/employee-scene-skill-package.ts';
import { parseWorkflowSkillSections } from '../packages/database/src/employees/workflow-skill.ts';

// Resolve public exports from the workspace that already owns this DSH generation.
const workerRequire = createRequire(
  new URL('../apps/worker/package.json', import.meta.url),
);
const metadataFields = [
  'schemaVersion',
  'version',
  'sourceRef',
  'license',
  'reviewedBy',
  'dependencies',
];
const resourceSchema = SkillBundleSchema.shape.resources.element
  .pick({ path: true, mediaType: true, byteLength: true, checksum: true })
  .partial({ byteLength: true, checksum: true });

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function objectKeys(value, keys, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(file, 'expected an object');
  const unsupported = Object.keys(value).filter((key) => !keys.includes(key));
  if (unsupported.length)
    fail(file, `unsupported fields: ${unsupported.join(', ')}`);
}

function checked(schema, value, file) {
  const result = schema.safeParse(value);
  if (!result.success) {
    fail(
      file,
      result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}

// Only explicit regular files are read. Reject links at every package-relative
// component, so a references/ directory cannot point outside the chosen package.
async function readLocalFile(root, relative, maxBytes) {
  const parts = relative.split('/');
  let path = root;
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())
    ) {
      fail(
        relative,
        'expected a regular file inside the package; symbolic links are unsupported',
      );
    }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(relative, 'expected a regular file');
    if (maxBytes !== undefined && info.size > maxBytes)
      fail(relative, `exceeds C1 resource limit (${maxBytes} bytes)`);
    const bytes = await handle.readFile();
    if (maxBytes !== undefined && bytes.length > maxBytes)
      fail(relative, `exceeds C1 resource limit (${maxBytes} bytes)`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function utf8(bytes, file) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    fail(file, 'expected valid UTF-8');
  }
}

function json(bytes, file) {
  try {
    return JSON.parse(utf8(bytes, file));
  } catch {
    fail(file, 'expected valid UTF-8 JSON');
  }
}

function checkRepresentableFrontmatter(bytes) {
  // Format inspection only. Native parsing below owns invocation semantics.
  // The public Provider below remains authoritative for names and body parsing.
  const lines = utf8(bytes, 'SKILL.md').split('\n');
  const delimiter = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  const end = lines.findIndex(
    (line, index) => index > 0 && delimiter(line) === '---',
  );
  if (delimiter(lines[0]) !== '---' || end < 0)
    fail('SKILL.md', 'expected YAML frontmatter delimited by ---');
  // Inspect YAML with normalized line endings, including its last CRLF line.
  // The native parser still receives the original file bytes below.
  const document = parseDocument(lines.slice(1, end).map(delimiter).join('\n'));
  if (document.errors.length)
    fail('SKILL.md', `invalid YAML: ${document.errors[0].message}`);
  objectKeys(
    document.toJS(),
    [
      'name',
      'description',
      'whenToUse',
      'metadata',
      'disable-model-invocation',
      'user-invocable',
    ],
    'SKILL.md frontmatter',
  );
}

async function parseNativeSkill(bytes) {
  const [{ Context }, { FileSystemSkillProvider }] = await Promise.all([
    import(pathToFileURL(workerRequire.resolve('@deepseek-ai/cordis')).href),
    import(
      pathToFileURL(workerRequire.resolve('@deepseek-ai/dsh-skill-filesystem'))
        .href
    ),
  ]);
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'allrice-workflow-pack-'),
  );
  const control = new globalThis.AbortController();
  let provider;
  try {
    await mkdir(join(root, 'input'));
    await writeFile(join(root, 'input', 'SKILL.md'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    provider = new FileSystemSkillProvider(
      new Context(),
      { signal: control.signal, invalidate() {} },
      {
        customSkillDirs: [root],
        dshHome: root,
        agentsHome: root,
        includeDefaultRoots: false,
        watch: false,
      },
    );
    const options = { cwd: root, signal: control.signal };
    const candidates = await provider.list(options);
    if (!Array.isArray(candidates) || candidates.length !== 1)
      fail(
        'SKILL.md',
        'native Provider rejected the skill; check name/description and parser warning',
      );
    const skill = await provider.get(candidates[0], options);
    if (!skill) fail('SKILL.md', 'native Provider could not load the skill');
    return skill;
  } finally {
    control.abort();
    await provider?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

/** Offline C1 content only. No account, publication, runtime or script execution. */
export async function packWorkflowSkill({ directory, sceneId, title }) {
  const root = await realpath(directory);
  const skillBytes = await readLocalFile(
    root,
    'SKILL.md',
    personalSkillLimits.sourceBytes,
  );
  checkRepresentableFrontmatter(skillBytes);
  const skill = await parseNativeSkill(skillBytes);
  if (Buffer.byteLength(skill.content) > personalSkillLimits.bodyBytes)
    fail('SKILL.md', 'body exceeds 262144 UTF-8 bytes');
  const parsed = WorkflowSkillFrontmatterSchema.safeParse({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    invocation: skill.invocation,
    metadata: skill.metadata,
  });
  if (!parsed.success) fail('SKILL.md', workflowSkillInvalidMessage);
  const frontmatter = parsed.data;
  parseWorkflowSkillSections(skill.content);
  const bundleBytes = await readLocalFile(root, 'bundle.json');
  const input = json(bundleBytes, 'bundle.json');
  objectKeys(
    input,
    [
      'schemaVersion',
      'version',
      'sourceRef',
      'license',
      'reviewedBy',
      'dependencies',
      'resources',
      'checksum',
      'contentChecksum',
    ],
    'bundle.json',
  );
  const {
    resources: resourceInputs,
    checksum: expectedChecksum,
    contentChecksum: expectedContentChecksum,
    ...fields
  } = input;
  const metadata = Object.fromEntries(
    metadataFields.map((key) => [
      key,
      checked(SkillBundleSchema.shape[key], fields[key], `bundle.json ${key}`),
    ]),
  );
  if (!Array.isArray(resourceInputs) || resourceInputs.length > 32)
    fail(
      'bundle.json resources',
      'expected an array with at most 32 resources (C1 limit)',
    );
  const resources = [];
  for (const [index, value] of resourceInputs.entries()) {
    const resource = checked(
      resourceSchema,
      value,
      `bundle.json resources.${index}`,
    );
    const bytes = await readLocalFile(root, resource.path, 131072);
    const checksum = skillBytesChecksum(bytes);
    if (resource.checksum !== undefined && resource.checksum !== checksum)
      fail(resource.path, 'checksum does not match bundle.json');
    if (
      resource.byteLength !== undefined &&
      resource.byteLength !== bytes.length
    )
      fail(resource.path, 'byteLength does not match bundle.json');
    resources.push({
      path: resource.path,
      mediaType: resource.mediaType,
      byteLength: bytes.length,
      checksum,
      contentBase64: bytes.toString('base64'),
    });
  }
  const payload = {
    ...metadata,
    contentChecksum: skillBytesChecksum(skill.content),
    resources,
  };
  const bundle = { ...payload, checksum: skillBundleChecksum(payload) };
  if (
    expectedContentChecksum !== undefined &&
    expectedContentChecksum !== bundle.contentChecksum
  )
    fail('bundle.json contentChecksum', 'does not match native parsed body');
  if (expectedChecksum !== undefined && expectedChecksum !== bundle.checksum)
    fail('bundle.json checksum', 'does not match packed bundle');
  checked(SkillBundleSchema, bundle, 'bundle.json');
  try {
    validateSkillBundle(bundle, skill.content);
  } catch (error) {
    fail('bundle.json', error.message);
  }

  let sources = { references: [], resourceSources: [] };
  try {
    await lstat(join(root, 'sources.json'));
    sources = json(await readLocalFile(root, 'sources.json'), 'sources.json');
  } catch (error) {
    if (error.code !== 'ENOENT' || error.path !== join(root, 'sources.json'))
      throw error;
  }
  objectKeys(sources, ['references', 'resourceSources'], 'sources.json');
  const references = checked(
    EmployeeContentReferenceSchema.array().max(128),
    sources.references,
    'sources.json references',
  );
  const skillPackage = checked(
    EmployeeSceneSkillPayloadSchema,
    { bundle, frontmatter, resourceSources: sources.resourceSources },
    'sources.json resourceSources',
  );
  try {
    validateSceneSkillPackage(skillPackage, skill.content, references);
  } catch {
    fail(
      'sources.json',
      'each resource reference must be declared in references',
    );
  }
  const procedure = checked(
    EmployeeContentTextSchema,
    { kind: 'procedure', title, body: skill.content, skillPackage },
    'C1 procedure',
  );
  // The personal import contract uses the native author name. The backend
  // shared scene snapshot keeps its original UUID contract.
  const scene = checked(
    PersonalSceneFileSchema.shape.scene,
    {
      id: sceneId,
      name: frontmatter.metadata.displayName,
      appliesWhen: skill.description,
      nativeName: frontmatter.name,
    },
    'scene mapping',
  );
  return {
    schemaVersion: 1,
    scene,
    procedure,
    references,
    report: {
      authorName: skill.name,
      nativeCommand: `/${scene.nativeName}`,
      skillFileChecksum: skillBytesChecksum(skillBytes),
      bundleFileChecksum: skillBytesChecksum(bundleBytes),
      contentChecksum: bundle.contentChecksum,
      bundleChecksum: bundle.checksum,
      dependencies: bundle.dependencies.map((dependency) =>
        dependency.kind === 'tool'
          ? {
              ...dependency,
              ...allRiceToolManifest.find(
                (tool) => tool.canonicalName === dependency.name,
              ),
            }
          : dependency,
      ),
      scripts: resources
        .filter((resource) => resource.path.startsWith('scripts/'))
        .map((resource) => resource.path),
      scriptsExecuted: false,
      published: false,
    },
  };
}

const help = `Usage: node --import tsx scripts/workflow-skill-pack.mjs <skill-directory>
  --scene-id <UUID> --title <procedure title>

Reads SKILL.md, bundle.json and optional sources.json; writes deterministic C1
content JSON to stdout. No publication, database, network or script execution.
See docs/development/workflow-skills.md. Run from this repository after pnpm
install --frozen-lockfile and pnpm --filter @allrice/contracts build.\n`;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        'scene-id': { type: 'string' },
        title: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) process.stdout.write(help);
    else {
      if (positionals.length !== 1 || !values['scene-id'] || !values.title)
        throw new Error(help);
      const result = await packWorkflowSkill({
        directory: positionals[0],
        sceneId: values['scene-id'],
        title: values.title,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`workflow-skill-pack: ${error.message}`);
    process.exitCode = 1;
  }
}
