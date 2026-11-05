import {
  EmployeeContentManifestSchema,
  EmployeeContentTextSchema,
  EmployeeSceneSkillPinSchema,
  PersonalSceneContentRefSchema,
  PersonalSceneSkillCatalogSchema,
  PersonalSceneSkillSchema,
  PersonalSceneSkillResourceSchema,
  PersonalSceneSkillSaveReceiptSchema,
  SavePersonalSceneSkillSchema,
  RestorePersonalSceneFileSchema,
  SkillResourcePathSchema,
  UuidSchema,
  employeeContentLimits,
  type EmployeeContentReference,
  type EmployeeSceneSkillPin,
  type RequestContext,
  type WorkflowSkillFrontmatter,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import { employeeChatUuid } from './employee-chat-authority.ts';
import { resolveEmployeeMethodTarget } from './employee-method-target.ts';
import {
  mutateEmployeeContentInTransaction,
  readPersonalEmployeeSceneLayer,
} from './employee-content.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';
import { parseWorkflowSkillSections } from './workflow-skill.ts';
import {
  EmployeeContentError,
  type ContentSql,
  type ContentTx,
} from './employee-content-model.ts';

type Context = Parameters<typeof readPersonalEmployeeSceneLayer>[0];
type Layer = NonNullable<
  Awaited<ReturnType<typeof readPersonalEmployeeSceneLayer>>['layer']
>;
type Scene = Layer['revision']['manifest']['scenes'][number];
const referenceKey = (ref: EmployeeContentReference) =>
  runtimePolicyDigest(ref);

export function personalSceneContentRef(pin: EmployeeSceneSkillPin) {
  return (
    'ps1.' +
    Buffer.from(
      JSON.stringify([
        pin.setId,
        pin.revisionId,
        pin.sceneId,
        pin.sourceRevisionId,
      ]),
    ).toString('base64url')
  );
}
export function parsePersonalSceneContentRef(
  raw: string,
): EmployeeSceneSkillPin {
  try {
    const ref = PersonalSceneContentRefSchema.parse(raw);
    if (!ref.startsWith('ps1.')) throw new Error('invalid_address');
    const parts: unknown = JSON.parse(
      Buffer.from(ref.slice(4), 'base64url').toString('utf8'),
    );
    if (!Array.isArray(parts) || parts.length !== 4)
      throw new Error('invalid_address');
    const pin = EmployeeSceneSkillPinSchema.parse({
      setId: parts[0],
      revisionId: parts[1],
      sceneId: parts[2],
      sourceRevisionId: parts[3],
    });
    if (personalSceneContentRef(pin) !== ref)
      throw new Error('invalid_address');
    return pin;
  } catch {
    throw new DataAccessError('not_found');
  }
}

/** Only the scene's own package and controlled sources enter the new contract.
 * Unchanged historical common/plain procedures remain stored, never inherited. */
async function resolvePackage(
  context: Context,
  instanceId: string,
  employeeId: string,
  layer: Layer,
  scene: Scene,
  sql: ContentSql,
  lock: boolean,
  allowDraft = false,
) {
  const procedures = scene.references.filter(
    (ref) => ref.sourceKind === 'procedure',
  );
  if (
    procedures.length !== 1 ||
    scene.references.some(
      (ref) =>
        ref.sourceKind === 'requirement' || ref.sourceKind === 'workflow',
    )
  )
    throw new DataAccessError('not_found');
  const ref = procedures[0]!;
  const resolved = [];
  for (const source of [...scene.references].sort((a, b) =>
    referenceKey(a).localeCompare(referenceKey(b)),
  )) {
    const value = await resolveEmployeeContentSource({
      context,
      instanceId,
      employeeId,
      sceneId: scene.id,
      ownership: layer.ownership,
      ref: source,
      sql,
      lock,
      allowDraft,
      frozenPublication: true,
    });
    if (!value.dto.available) throw new DataAccessError('not_found');
    resolved.push(value);
  }
  const [row] = await sql<{ content: unknown; digest: string }[]>`
    select content,digest from allrice_company_asset_revisions
    where organization_id=${context.organizationId} and asset_id=${ref.contentId} and id=${ref.revisionId}`;
  if (
    !row ||
    row.digest !== ref.digest ||
    runtimePolicyDigest(row.content) !== ref.digest
  )
    throw new DataAccessError('not_found');
  const text = EmployeeContentTextSchema.parse(row.content);
  if (!('skillPackage' in text)) throw new DataAccessError('not_found');
  validateSceneSkillPackage(text.skillPackage, text.body, scene.references);
  const pin = {
    setId: layer.setId,
    revisionId: layer.revision.id,
    sceneId: scene.id,
    sourceRevisionId: ref.revisionId,
  };
  const bundle = text.skillPackage.bundle;
  const frontmatter = text.skillPackage.frontmatter;
  const skill = PersonalSceneSkillSchema.parse({
    ...summary(scene, frontmatter),
    ...(frontmatter
      ? {
          frontmatter,
          whenToUse: frontmatter.whenToUse,
          ...parseWorkflowSkillSections(text.body),
        }
      : {}),
    contentRef: personalSceneContentRef(pin),
    revision: layer.revision.number,
    content: text.body,
    contentChecksum: bundle.contentChecksum,
    bundleVersion: bundle.version,
    bundleChecksum: bundle.checksum,
    resources: bundle.resources.map(
      ({ path, mediaType, byteLength, checksum }) => ({
        path,
        mediaType,
        byteLength,
        checksum,
      }),
    ),
    sources: resolved.map(({ dto }) => ({
      reference: dto.reference,
      title: dto.title ?? '',
    })),
  });
  return { skill, pin, bundle, resolved };
}
function summary(scene: Scene, frontmatter?: WorkflowSkillFrontmatter) {
  return {
    sceneId: scene.id,
    name: frontmatter?.metadata.displayName ?? scene.name,
    description: frontmatter?.description ?? scene.appliesWhen,
    nativeName: `allrice-scene-${scene.id}`,
    ...(frontmatter ? { version: frontmatter.metadata.version } : {}),
  };
}

/** Internal transaction reader. Runtime callers must use the leased, recorded
 * entry point; this primitive alone is not permission to return model bytes. */
export async function readPersonalSceneSkillInTransaction(
  context: Context,
  instanceId: string,
  selection: { sceneId: string } | { contentRef: string },
  sql: ContentSql,
  lock = false,
) {
  const pin =
    'contentRef' in selection
      ? parsePersonalSceneContentRef(selection.contentRef)
      : undefined;
  const sceneId =
    pin?.sceneId ??
    UuidSchema.parse('sceneId' in selection ? selection.sceneId : undefined);
  const view = await readPersonalEmployeeSceneLayer(
    context,
    instanceId,
    sql,
    pin,
    lock,
  );
  const scene = view.layer?.revision.manifest.scenes.find(
    (item) => item.id === sceneId,
  );
  if (!view.layer || !scene) throw new DataAccessError('not_found');
  const pkg = await resolvePackage(
    context,
    view.instanceId,
    view.employeeId,
    view.layer,
    scene,
    sql,
    lock,
  );
  if (pin && pkg.pin.sourceRevisionId !== pin.sourceRevisionId)
    throw new DataAccessError('not_found');
  return pkg;
}

export async function listPersonalSceneSkillsInTransaction(
  context: Context,
  instanceId: string,
  tx: ContentSql,
  lock = false,
) {
  const view = await readPersonalEmployeeSceneLayer(
    context,
    instanceId,
    tx,
    undefined,
    lock,
  );
  const skills = [];
  if (view.layer)
    for (const scene of view.layer.revision.manifest.scenes) {
      try {
        const pkg = await resolvePackage(
          context,
          view.instanceId,
          view.employeeId,
          view.layer,
          scene,
          tx,
          lock,
        );
        skills.push({
          sceneId: pkg.skill.sceneId,
          name: pkg.skill.name,
          description: pkg.skill.description,
          nativeName: pkg.skill.nativeName,
          ...(pkg.skill.version ? { version: pkg.skill.version } : {}),
          contentRef: pkg.skill.contentRef,
          revision: pkg.skill.revision,
        });
      } catch (error) {
        if (!(error instanceof DataAccessError && error.code === 'not_found'))
          throw error;
      }
    }
  return PersonalSceneSkillCatalogSchema.parse({
    instanceId: view.instanceId,
    revision: view.revision,
    skills,
  });
}
export async function listPersonalSceneSkills(
  context: Context,
  instanceId: string,
  db = getDatabase(),
) {
  return db.begin('isolation level repeatable read read only', async (tx) =>
    listPersonalSceneSkillsInTransaction(context, instanceId, tx),
  );
}
export async function getPersonalSceneSkill(
  context: Context,
  instanceId: string,
  sceneId: string,
  db = getDatabase(),
) {
  return db.begin(
    'isolation level repeatable read read only',
    async (tx) =>
      (
        await readPersonalSceneSkillInTransaction(
          context,
          instanceId,
          { sceneId },
          tx,
        )
      ).skill,
  );
}
export async function getPersonalSceneSkillResource(
  context: Context,
  instanceId: string,
  contentRef: string,
  pathInput: string,
  db = getDatabase(),
) {
  const path = SkillResourcePathSchema.parse(pathInput);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const pkg = await readPersonalSceneSkillInTransaction(
      context,
      instanceId,
      { contentRef },
      tx,
    );
    const resource = pkg.bundle.resources.find((item) => item.path === path);
    if (!resource) throw new DataAccessError('not_found');
    return PersonalSceneSkillResourceSchema.parse({
      contentRef: pkg.skill.contentRef,
      bundleChecksum: pkg.bundle.checksum,
      ...resource,
    });
  });
}

/** Authenticated human submission. The model-facing save/approval tool is not
 * extended by this API; owner and target always come from the real instance. */
export async function savePersonalSceneSkill(
  contextInput: RequestContext,
  instanceId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = SavePersonalSceneSkillSchema.parse(raw);
  return db.begin(async (tx) =>
    savePersonalSceneSkillInTransaction(contextInput, instanceId, input, tx),
  );
}

/** The existing personal writer, composed inside the caller's transaction.
 * Restore selects an exact old package only after request/CAS admission. It
 * reuses its source references rather than cloning bytes into a new asset. */
export async function savePersonalSceneSkillInTransaction(
  contextInput: RequestContext,
  instanceId: string,
  raw: unknown,
  tx: ContentTx,
) {
  const input = SavePersonalSceneSkillSchema.or(
    RestorePersonalSceneFileSchema,
  ).parse(raw);
  const save = 'scene' in input ? input : null;
  const restore = 'restoreContentRef' in input ? input : null;
  const restorePin = restore
    ? parsePersonalSceneContentRef(restore.restoreContentRef)
    : null;
  const sceneId = restorePin?.sceneId ?? save!.scene.id;
  if (restore && restore.sceneId !== sceneId)
    throw new DataAccessError('not_found');
  const context = { ...contextInput, workspaceId: input.workspaceId };
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  if (save && !('skillPackage' in save.procedure))
    throw new EmployeeContentError('validation_failed');
  if (
    save?.references.some((ref) =>
      ['procedure', 'requirement', 'workflow'].includes(ref.sourceKind),
    )
  )
    throw new EmployeeContentError('validation_failed');
  const procedure = save?.procedure;
  const bundle =
    procedure && 'skillPackage' in procedure
      ? procedure.skillPackage.bundle
      : null;
  if (procedure && 'skillPackage' in procedure)
    validateSceneSkillPackage(
      procedure.skillPackage,
      procedure.body,
      save!.references,
    );
  const authorize = async () => {
    const instance = await getEmployeeInstance(context, instanceId, tx);
    if (instance.kind !== 'custom') throw new DataAccessError('not_found');
  };
  await authorize();
  const target = await resolveEmployeeMethodTarget(
    context,
    instanceId,
    undefined,
    tx,
  );
  const contentId = employeeChatUuid(
    'personal-scene-package',
    instanceId,
    input.requestId,
  );
  const sourceRevisionId =
    restorePin?.sourceRevisionId ??
    employeeChatUuid(
      'personal-scene-package-revision',
      instanceId,
      input.requestId,
    );
  const mutation = {
    setId: target.setId,
    target: target.target,
    ownership: target.ownership,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    changeSummary: input.changeSummary,
    operation: 'save_draft' as const,
    manifest: {
      schemaVersion: 1 as const,
      common: [],
      scenes: [],
      declaredConflicts: [],
    },
    textEdits: [],
  };
  const receipt = await mutateEmployeeContentInTransaction(
    context,
    mutation,
    tx,
    {
      authorize,
      publishOnSave: true,
      inputDigest: runtimePolicyDigest({ instanceId, input }),
      buildInput: async (row) => {
        // As with existing immediate saves, start from active content. An
        // unrelated unenabled draft remains immutable history.
        const [saved] = row?.active_revision_id
          ? await tx<{ manifest: unknown }[]>`
          select manifest from allrice_employee_content_revisions where id=${row.active_revision_id} and set_id=${row.id}`
          : [];
        const previous = saved
          ? EmployeeContentManifestSchema.parse(saved.manifest)
          : mutation.manifest;
        const scene = previous.scenes.find((item) => item.id === sceneId);
        // Compare only immutable package identity, not old source bytes or
        // readability: an owner must be able to replace a revoked package.
        // Plain procedures and other references are not packages. Missing or
        // mismatched source identity is not evidence that the scene is empty.
        const packages = [];
        for (const ref of scene?.references ?? []) {
          if (ref.sourceKind !== 'procedure') continue;
          const [source] = await tx<
            {
              digest: string;
              kind: string;
              packaged: boolean;
            }[]
          >`select digest,content->>'kind' as kind,content ? 'skillPackage' as packaged
              from allrice_company_asset_revisions
              where organization_id=${context.organizationId} and asset_id=${ref.contentId} and id=${ref.revisionId}`;
          if (
            !source ||
            source.digest !== ref.digest ||
            source.kind !== 'procedure'
          )
            throw new EmployeeContentError('source_changed');
          if (source.packaged) packages.push(ref);
        }
        if (packages.length > 1)
          throw new EmployeeContentError('version_conflict');
        const previousPackage = packages[0];
        const expectedContentRef = previousPackage
          ? personalSceneContentRef({
              setId: row!.id,
              revisionId: row!.active_revision_id!,
              sceneId: scene!.id,
              sourceRevisionId: previousPackage.revisionId,
            })
          : null;
        if (input.expectedContentRef !== expectedContentRef)
          throw new EmployeeContentError('version_conflict');
        if (restore) {
          // Locks publication, current principal and every exact source until
          // commit, after the shared writer has handled same-request replay.
          const old = await readPersonalSceneSkillInTransaction(
            context,
            instanceId,
            { contentRef: restore.restoreContentRef },
            tx,
            true,
          );
          if (
            old.skill.contentChecksum !== restore.contentChecksum ||
            old.skill.bundleChecksum !== restore.bundleChecksum
          )
            throw new EmployeeContentError('source_changed');
          const source = await readPersonalEmployeeSceneLayer(
            context,
            instanceId,
            tx,
            old.pin,
            true,
          );
          const restoredScene = source.layer?.revision.manifest.scenes.find(
            (item) => item.id === sceneId,
          );
          if (!restoredScene) throw new DataAccessError('not_found');
          return {
            ...mutation,
            manifest: {
              ...previous,
              scenes: scene
                ? previous.scenes.map((item) =>
                    item.id === sceneId ? restoredScene : item,
                  )
                : [...previous.scenes, restoredScene],
            },
            textEdits: [],
          };
        }
        const next = {
          ...save!.scene,
          references: [
            ...save!.references,
            { sourceKind: 'draft_text' as const, contentId },
          ],
        };
        return {
          ...mutation,
          manifest: {
            ...previous,
            scenes: scene
              ? previous.scenes.map((item) =>
                  item.id === next.id ? next : item,
                )
              : [...previous.scenes, next],
          },
          textEdits: [
            {
              ...procedure!,
              contentId,
              revisionId: sourceRevisionId,
              expectedRevision: 0,
            },
          ],
        };
      },
      validateCandidate: async ({ row, revision, target: resolvedTarget }) => {
        const scene = revision.manifest.scenes.find(
          (item) => item.id === sceneId,
        )!;
        const pkg = await resolvePackage(
          context,
          instanceId,
          resolvedTarget.employeeId,
          {
            setId: row.id,
            ownership: target.ownership,
            revision: {
              ...revision,
              changeSummary: revision.change_summary,
              createdAt: revision.created_at.toISOString(),
              restoredFromRevisionId: revision.restored_from_revision_id,
            },
            publishedAt: '',
          },
          scene,
          tx,
          true,
          true,
        );
        if (
          pkg.resolved.reduce(
            (bytes, source) => bytes + Buffer.byteLength(source.dto.body ?? ''),
            0,
          ) > employeeContentLimits.textBytes
        )
          throw new EmployeeContentError('validation_failed');
        return {
          resolved: pkg.resolved,
          validation: {
            valid: true,
            issues: [],
            dependencyDigest: runtimePolicyDigest(
              pkg.resolved.map((source) => source.dependency),
            ),
            semanticConsistency: 'not_proven' as const,
          },
        };
      },
    },
  );
  const contentRef = personalSceneContentRef({
    setId: receipt.setId,
    revisionId: receipt.active!.id,
    sceneId,
    sourceRevisionId,
  });
  // The stored request digest binds these validated input checksums. Replays
  // return the original success metadata even if its sources were revoked;
  // they do not read bytes or grant permission to read them again.
  return PersonalSceneSkillSaveReceiptSchema.parse({
    instanceId,
    sceneId,
    revision: receipt.revision,
    contentRef,
    contentChecksum: restore?.contentChecksum ?? bundle!.contentChecksum,
    bundleChecksum: restore?.bundleChecksum ?? bundle!.checksum,
  });
}
