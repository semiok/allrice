import {
  EmployeeContentTextSchema,
  EmployeeSceneSkillPinSchema,
  EmployeeSceneSkillCatalogSchema,
  EmployeePublishedSceneSkillSchema,
  EmployeeSceneSkillSummarySchema,
  SkillResourcePathSchema,
  type EmployeeSceneSkillPin,
  type EmployeePublishedSceneSkill,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { readPublishedEmployeeSceneLayers } from './employee-content.ts';
import { resolveEmployeeContentSource } from './employee-content-sources.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';
import type { ContentTx } from './employee-content-model.ts';

type Context = Parameters<typeof readPublishedEmployeeSceneLayers>[0];
type Layer = Awaited<
  ReturnType<typeof readPublishedEmployeeSceneLayers>
>['layers'][number];

async function readScenePackages(
  context: Context,
  instanceId: string,
  employeeId: string,
  layer: Layer,
  scene: Layer['revision']['manifest']['scenes'][number],
  tx: ContentTx,
  sourceRevisionId?: string,
): Promise<EmployeePublishedSceneSkill[]> {
  const references = [...layer.revision.manifest.common, ...scene.references];
  // Authorize each reference against the layer that published it. A personal
  // reader's broader access must never widen a company or department package.
  for (const ref of references) {
    const resolved = await resolveEmployeeContentSource({
      context,
      instanceId,
      employeeId,
      sceneId: scene.id,
      ownership: layer.ownership,
      ref,
      sql: tx,
      lock: false,
      allowDraft: false,
      frozenPublication: true,
    });
    if (!resolved.dto.available) return [];
  }
  const packages: EmployeePublishedSceneSkill[] = [];
  for (const ref of scene.references) {
    if (
      ref.sourceKind !== 'procedure' ||
      (sourceRevisionId && sourceRevisionId !== ref.revisionId)
    )
      continue;
    const [row] = await tx<
      {
        content: unknown;
        digest: string;
        number: number;
        created_by: string;
        created_at: Date;
      }[]
    >`select content,digest,number,created_by,created_at from allrice_company_asset_revisions
      where organization_id=${context.organizationId} and asset_id=${ref.contentId} and id=${ref.revisionId}`;
    if (!row) continue;
    const parsed = EmployeeContentTextSchema.safeParse(row.content);
    if (!parsed.success || !('skillPackage' in parsed.data)) continue;
    // The source digest signs the body, complete bundle and controlled-source mapping.
    if (
      row.digest !== ref.digest ||
      runtimePolicyDigest(row.content) !== ref.digest
    )
      continue;
    const text = parsed.data;
    try {
      validateSceneSkillPackage(text.skillPackage, text.body, references);
    } catch {
      continue;
    }
    const bundle = text.skillPackage.bundle;
    packages.push(
      EmployeePublishedSceneSkillSchema.parse({
        pin: {
          setId: layer.setId,
          revisionId: layer.revision.id,
          sceneId: scene.id,
          sourceRevisionId: ref.revisionId,
        },
        ownership: layer.ownership,
        publication: {
          number: layer.revision.number,
          digest: layer.revision.digest,
          publishedAt: layer.publishedAt,
        },
        scene,
        common: layer.revision.manifest.common,
        source: {
          reference: ref,
          number: row.number,
          createdBy: row.created_by,
          createdAt: row.created_at.toISOString(),
        },
        bundleVersion: bundle.version,
        bundleChecksum: bundle.checksum,
        contentChecksum: bundle.contentChecksum,
        resources: bundle.resources.map(
          ({ path, mediaType, byteLength, checksum }) => ({
            path,
            mediaType,
            byteLength,
            checksum,
          }),
        ),
        content: text.body,
        skillPackage: text.skillPackage,
      }),
    );
  }
  return packages;
}

/** A storage catalog, not a DSH provider. Preserve additive layer order; this
 * does not select a winning skill, pin a stage, load tools, or execute content. */
export async function listEmployeeSceneSkills(
  context: Context,
  instanceId: string,
  db = getDatabase(),
) {
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const view = await readPublishedEmployeeSceneLayers(
      context,
      instanceId,
      tx,
    );
    const skills = [];
    for (const layer of view.layers) {
      for (const scene of layer.revision.manifest.scenes) {
        for (const pkg of await readScenePackages(
          context,
          view.instanceId,
          view.employeeId,
          layer,
          scene,
          tx,
        )) {
          // Explicit response whitelist; never serialize package bytes into a catalog.
          skills.push(EmployeeSceneSkillSummarySchema.strip().parse(pkg));
        }
      }
    }
    return EmployeeSceneSkillCatalogSchema.parse({
      instanceId: view.instanceId,
      employeeId: view.employeeId,
      skills,
    });
  });
}

async function readPinnedPackage(
  context: Context,
  instanceId: string,
  pin: EmployeeSceneSkillPin,
  tx: ContentTx,
) {
  const view = await readPublishedEmployeeSceneLayers(
    context,
    instanceId,
    tx,
    pin,
  );
  const layer = view.layers.find((candidate) => candidate.setId === pin.setId)!;
  const scene = layer.revision.manifest.scenes.find(
    (candidate) => candidate.id === pin.sceneId,
  );
  if (!scene) throw new DataAccessError('not_found');
  const packages = await readScenePackages(
    context,
    view.instanceId,
    view.employeeId,
    layer,
    scene,
    tx,
    pin.sourceRevisionId,
  );
  const pkg = packages[0];
  if (!pkg) throw new DataAccessError('not_found');
  return pkg;
}

export async function getEmployeeSceneSkill(
  context: Context,
  instanceId: string,
  pinInput: EmployeeSceneSkillPin,
  db = getDatabase(),
) {
  const pin = EmployeeSceneSkillPinSchema.parse(pinInput);
  return db.begin('isolation level repeatable read read only', async (tx) =>
    readPinnedPackage(context, instanceId, pin, tx),
  );
}

/** The path is only an index into this exact authorized package. No host paths,
 * mutable latest lookup, script execution, or checksum-only resource endpoint. */
export async function getEmployeeSceneSkillResource(
  context: Context,
  instanceId: string,
  pinInput: EmployeeSceneSkillPin,
  pathInput: string,
  db = getDatabase(),
) {
  const pin = EmployeeSceneSkillPinSchema.parse(pinInput);
  const path = SkillResourcePathSchema.parse(pathInput);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    const pkg = await readPinnedPackage(context, instanceId, pin, tx);
    const resource = pkg.skillPackage.bundle.resources.find(
      (candidate) => candidate.path === path,
    );
    if (!resource) throw new DataAccessError('not_found');
    return {
      pin: pkg.pin,
      bundleVersion: pkg.bundleVersion,
      bundleChecksum: pkg.bundleChecksum,
      ...resource,
    };
  });
}
