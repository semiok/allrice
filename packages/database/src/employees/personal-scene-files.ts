import {
  PersonalSceneFileHistorySchema,
  PersonalSceneFilePreviewSchema,
  PreviewPersonalSceneFileSchema,
  EmployeeContentTextSchema,
  type PersonalSceneFilePreview,
  type PersonalSceneSkill,
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
} from './personal-scene-skills.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';
import { EmployeeContentError } from './employee-content-model.ts';

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
  const { file } = input;
  if (!('skillPackage' in file.procedure))
    throw new DataAccessError('not_found');
  validateSceneSkillPackage(
    file.procedure.skillPackage,
    file.procedure.body,
    file.references,
  );
  return db.begin('isolation level repeatable read read only', async (tx) => {
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
      if (
        !source ||
        source.kind !== 'procedure' ||
        source.digest !== ref.digest
      )
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
    return PersonalSceneFilePreviewSchema.parse({
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
    });
  });
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
    const seen = new Set<string>();
    const entries = [];
    for (const revision of history.revisions) {
      if (!published.has(revision.id)) continue;
      for (const scene of revision.manifest.scenes) {
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
        const identity = runtimePolicyDigest(scene);
        if (seen.has(identity)) continue;
        seen.add(identity);
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
