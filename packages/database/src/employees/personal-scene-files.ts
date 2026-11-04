import {
  PersonalSceneFileHistorySchema,
  PersonalSceneFilePreviewSchema,
  PreviewPersonalSceneFileSchema,
  PreviewPersonalSceneRestoreSchema,
  PersonalSceneRestorePreviewSchema,
  RestorePersonalSceneFileSchema,
  EmployeeContentTextSchema,
  EmployeeContentManifestSchema,
  type PersonalSceneFilePreview,
  type PersonalSceneSkill,
  type PersonalSceneFile,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { getEmployeeInstance } from './employee-instances.ts';
import {
  getEmployeeContentHistoryInTransaction,
  readPersonalEmployeeSceneLayer,
} from './employee-content.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';
import {
  personalSceneContentRef,
  readPersonalSceneSkillInTransaction,
  savePersonalSceneSkillInTransaction,
} from './personal-scene-skills.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';

function humanContext(context: RequestContext, workspaceId: string) {
  if (!context.sessionId || context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  return { ...context, workspaceId };
}

/** A preview is a human read, never a model read or an authorization receipt.
 * Saving still goes through savePersonalSceneSkill, which rechecks the current
 * assignment, exact old package, CAS, sources and package bytes under its lock. */
export async function previewPersonalSceneFile(
  contextInput: RequestContext,
  instanceId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = PreviewPersonalSceneFileSchema.parse(raw);
  const context = humanContext(contextInput, input.workspaceId);
  return db.begin('isolation level repeatable read read only', async (tx) =>
    PersonalSceneFilePreviewSchema.parse(
      await previewPersonalSceneFileInTransaction(
        context,
        instanceId,
        input.file,
        tx,
      ),
    ),
  );
}

async function previewPersonalSceneFileInTransaction(
  context: RequestContext,
  instanceId: string,
  file: PersonalSceneFile,
  tx: ContentTx,
) {
  if (!('skillPackage' in file.procedure))
    throw new DataAccessError('not_found');
  validateSceneSkillPackage(
    file.procedure.skillPackage,
    file.procedure.body,
    file.references,
  );
  const view = await readPersonalEmployeeSceneLayer(context, instanceId, tx);
  const instance = await getEmployeeInstance(context, instanceId, tx);
  const currentScene = view.layer?.revision.manifest.scenes.find(
    (scene) => scene.id === file.scene.id,
  );
  // Read-only identity projection from the already authorized manifest. Do
  // not require old bytes to remain readable just to replace a revoked pack.
  // The save builder independently rechecks this identity under its lock.
  const packages = [];
  for (const ref of currentScene?.references ?? []) {
    if (ref.sourceKind !== 'procedure') continue;
    const [source] = await tx<
      { kind: string; digest: string; packaged: boolean }[]
    >`select content->>'kind' as kind,digest,content ? 'skillPackage' as packaged
        from allrice_company_asset_revisions
        where organization_id=${context.organizationId} and asset_id=${ref.contentId} and id=${ref.revisionId}`;
    if (!source || source.kind !== 'procedure' || source.digest !== ref.digest)
      throw new EmployeeContentError('source_changed');
    if (source.packaged) packages.push(ref);
  }
  if (packages.length > 1) throw new EmployeeContentError('version_conflict');
  const expectedContentRef = packages[0]
    ? personalSceneContentRef({
        setId: view.layer!.setId,
        revisionId: view.layer!.revision.id,
        sceneId: file.scene.id,
        sourceRevisionId: packages[0].revisionId,
      })
    : null;
  let current: PersonalSceneSkill | null = null;
  let currentMetadata: PersonalSceneFilePreview['currentMetadata'] = null;
  if (expectedContentRef)
    try {
      const pkg = await readPersonalSceneSkillInTransaction(
        context,
        instanceId,
        { contentRef: expectedContentRef },
        tx,
      );
      current = pkg.skill;
      // Exact bytes have just been authorized by the existing reader. Read
      // their authoring metadata in the same immutable snapshot for the diff.
      const [source] = await tx<{ content: unknown }[]>`
          select content from allrice_company_asset_revisions
          where organization_id=${context.organizationId} and id=${pkg.pin.sourceRevisionId}`;
      const text = EmployeeContentTextSchema.parse(source?.content);
      if (!('skillPackage' in text))
        throw new EmployeeContentError('source_changed');
      currentMetadata = {
        title: text.title,
        bundle: {
          schemaVersion: pkg.bundle.schemaVersion,
          version: pkg.bundle.version,
          checksum: pkg.bundle.checksum,
          contentChecksum: pkg.bundle.contentChecksum,
          sourceRef: pkg.bundle.sourceRef,
          license: pkg.bundle.license,
          reviewedBy: pkg.bundle.reviewedBy,
          dependencies: pkg.bundle.dependencies,
        },
        resourceSources: text.skillPackage.resourceSources,
      };
    } catch (error) {
      if (!(error instanceof DataAccessError && error.code === 'not_found'))
        throw error;
    }
  const ownership = {
    scope: 'personal' as const,
    organizationId: context.organizationId,
    ownerId: context.actor.id,
  };
  for (const ref of file.references) {
    const source = await resolveEmployeeContentSource({
      context,
      instanceId,
      employeeId: view.employeeId,
      sceneId: file.scene.id,
      ownership,
      ref,
      sql: tx,
      lock: false,
      allowDraft: false,
      frozenPublication: true,
    });
    if (!source.dto.available) throw new DataAccessError('not_found');
  }
  return {
    instanceId: view.instanceId,
    instanceName: instance.profile.name ?? '我的 AI 员工',
    expectedRevision: view.revision,
    expectedContentRef,
    currentScene: currentScene ?? null,
    // Drop the untrusted D0 report: actual package fields are authoritative.
    file: {
      schemaVersion: file.schemaVersion,
      scene: file.scene,
      procedure: file.procedure,
      references: file.references,
    },
    current,
    currentMetadata,
  };
}

/** Human preview only. Commit reads this locator again under the writer's
 * publication/source locks; these returned bytes never become commit input. */
export async function previewPersonalSceneRestore(
  contextInput: RequestContext,
  instanceId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = PreviewPersonalSceneRestoreSchema.parse(raw);
  const context = humanContext(contextInput, input.workspaceId);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const pkg = await readPersonalSceneSkillInTransaction(
      context,
      instanceId,
      { contentRef: input.restoreContentRef },
      tx,
    );
    const source = await readPersonalEmployeeSceneLayer(
      context,
      instanceId,
      tx,
      pkg.pin,
    );
    const scene = source.layer?.revision.manifest.scenes.find(
      (item) => item.id === pkg.skill.sceneId,
    );
    if (!scene) throw new DataAccessError('not_found');
    const [row] = await tx<
      { content: unknown }[]
    >`select content from allrice_company_asset_revisions where organization_id=${context.organizationId} and id=${pkg.pin.sourceRevisionId}`;
    const procedure = EmployeeContentTextSchema.parse(row?.content);
    const file: PersonalSceneFile = {
      schemaVersion: 1,
      scene: {
        id: scene.id,
        name: scene.name,
        appliesWhen: scene.appliesWhen,
        nativeName: pkg.skill.nativeName,
      },
      procedure,
      references: scene.references,
    };
    const preview = await previewPersonalSceneFileInTransaction(
      context,
      instanceId,
      file,
      tx,
    );
    return PersonalSceneRestorePreviewSchema.parse({
      ...preview,
      restoreContentRef: input.restoreContentRef,
      restoreRevision: pkg.skill.revision,
    });
  });
}

export async function restorePersonalSceneFile(
  contextInput: RequestContext,
  instanceId: string,
  raw: unknown,
  db = getDatabase(),
) {
  const input = RestorePersonalSceneFileSchema.parse(raw);
  const context = humanContext(contextInput, input.workspaceId);
  return db.begin((tx) =>
    savePersonalSceneSkillInTransaction(context, instanceId, input, tx),
  );
}

/** Only domain metadata is returned. Every body's later read still checks the
 * current source ACL; a historical address is never a grant. */
export async function listPersonalSceneFileHistory(
  contextInput: RequestContext,
  instanceId: string,
  beforeRevision?: number,
  db = getDatabase(),
) {
  if (!contextInput.workspaceId) throw new DataAccessError('not_found');
  const context = humanContext(contextInput, contextInput.workspaceId);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const view = await readPersonalEmployeeSceneLayer(context, instanceId, tx);
    if (!view.layer)
      return PersonalSceneFileHistorySchema.parse({
        instanceId: view.instanceId,
        revision: view.revision,
        entries: [],
        nextBeforeRevision: null,
      });
    const history = await getEmployeeContentHistoryInTransaction(
      context,
      view.layer.setId,
      beforeRevision,
      tx,
    );
    const publications = await tx<{ revision_id: string }[]>`
      select revision_id from allrice_employee_content_publications
      where set_id=${view.layer.setId}`;
    const published = new Set(publications.map((row) => row.revision_id));
    const revisions = history.revisions.filter((revision) =>
      published.has(revision.id),
    );
    // A collection snapshot contains unchanged scenes too. Compare with the
    // previous published snapshot, including one predecessor beyond this page,
    // so the scene keeps the summary/time of the save that actually changed it.
    const oldest = revisions.at(-1);
    const [predecessor] = oldest
      ? await tx<{ manifest: unknown }[]>`
      select r.manifest from allrice_employee_content_revisions r
      join allrice_employee_content_publications p on p.set_id=r.set_id and p.revision_id=r.id
      where r.set_id=${view.layer.setId} and r.number<${oldest.number}
      order by r.number desc limit 1`
      : [];
    const predecessorManifest = predecessor
      ? EmployeeContentManifestSchema.parse(predecessor.manifest)
      : null;
    const entries = [];
    for (const [index, revision] of revisions.entries()) {
      const previous = revisions[index + 1]?.manifest ?? predecessorManifest;
      for (const scene of revision.manifest.scenes) {
        const previousScene = previous?.scenes.find(
          (entry) => entry.id === scene.id,
        );
        if (
          previousScene &&
          runtimePolicyDigest(previousScene) === runtimePolicyDigest(scene)
        )
          continue;
        const procedures = scene.references.filter(
          (ref) => ref.sourceKind === 'procedure',
        );
        if (procedures.length !== 1) continue;
        const reference = procedures[0]!;
        const [source] = await tx<{ packaged: boolean }[]>`
          select content ? 'skillPackage' as packaged
          from allrice_company_asset_revisions
          where organization_id=${context.organizationId} and asset_id=${reference.contentId}
            and id=${reference.revisionId} and digest=${reference.digest}`;
        if (!source?.packaged) continue;
        const contentRef = personalSceneContentRef({
          setId: view.layer.setId,
          revisionId: revision.id,
          sceneId: scene.id,
          sourceRevisionId: reference.revisionId,
        });
        let skill: PersonalSceneSkill | undefined;
        try {
          skill = (
            await readPersonalSceneSkillInTransaction(
              context,
              instanceId,
              { contentRef },
              tx,
            )
          ).skill;
        } catch (error) {
          if (!(error instanceof DataAccessError && error.code === 'not_found'))
            throw error;
        }
        entries.push({
          sceneId: scene.id,
          name: scene.name,
          revision: revision.number,
          contentRef,
          changeSummary: revision.changeSummary,
          createdAt: revision.createdAt,
          available: Boolean(skill),
          ...(skill && {
            contentChecksum: skill.contentChecksum,
            bundleChecksum: skill.bundleChecksum,
          }),
        });
      }
    }
    return PersonalSceneFileHistorySchema.parse({
      instanceId: view.instanceId,
      revision: history.revision,
      entries,
      nextBeforeRevision: history.nextBeforeRevision,
    });
  });
}
