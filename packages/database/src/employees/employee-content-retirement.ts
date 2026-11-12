import {
  EmployeeContentTextSchema,
  type EmployeeContentManifest,
  type EmployeeContentMutation,
  type EmployeeContentReference,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  EmployeeContentError,
  type ContentTx,
} from './employee-content-model.ts';
import { validateSceneSkillPackage } from './employee-scene-skill-package.ts';

type Save = Extract<EmployeeContentMutation, { operation: 'save_draft' }>;
type Manifest = Save['manifest'];

/** Retire text authoring at the shared writer, without retiring the package
 * store. Unchanged legacy pins may accompany a legal non-text edit; authorized
 * removal may only narrow their exact locations and scene identities, while
 * preserving legacy common, scene and reference order. */
export function assertEmployeeContentRetirementDelta(
  before: EmployeeContentManifest,
  after: Manifest,
  textEdits: Save['textEdits'],
  packagedPins: ReadonlySet<string>,
  previousPackagedPins: ReadonlySet<string> = packagedPins,
) {
  if (textEdits.some((edit) => !('skillPackage' in edit)))
    throw new EmployeeContentError('legacy_method_retired');
  const packageEdits = new Set(textEdits.map((edit) => edit.contentId));
  const isPackage = (
    ref: Manifest['common'][number],
    packages: ReadonlySet<string>,
  ) =>
    ref.sourceKind === 'draft_text'
      ? packageEdits.has(ref.contentId)
      : ref.sourceKind === 'procedure' &&
        packages.has(runtimePolicyDigest(ref));
  const isText = (
    ref: Manifest['common'][number],
    packages: ReadonlySet<string>,
  ) =>
    ref.sourceKind === 'requirement' ||
    (ref.sourceKind === 'procedure' && !isPackage(ref, packages));
  const locations = (
    manifest: Manifest,
    include: (ref: Manifest['common'][number]) => boolean,
  ) => [
    ...manifest.common
      .filter(include)
      .map((ref) => runtimePolicyDigest({ location: null, ref })),
    ...manifest.scenes.flatMap((scene) =>
      scene.references.filter(include).map((ref) =>
        runtimePolicyDigest({
          location: {
            id: scene.id,
            name: scene.name,
            appliesWhen: scene.appliesWhen,
          },
          ref,
        }),
      ),
    ),
  ];
  const previous = locations(before, (ref) =>
      isText(ref, previousPackagedPins),
    ),
    next = locations(after, (ref) => isText(ref, packagedPins));
  // Runtime assembly preserves these arrays; a non-text edit cannot authorize
  // reordering old instructions. The remaining placements must be a subsequence.
  let cursor = 0;
  for (const key of next) {
    while (cursor < previous.length && previous[cursor] !== key) cursor++;
    if (cursor === previous.length)
      throw new EmployeeContentError('legacy_method_retired');
    cursor++;
  }
  if (
    next.length &&
    previous.length === next.length &&
    runtimePolicyDigest(
      locations(before, (ref) => !isText(ref, previousPackagedPins)),
    ) ===
      runtimePolicyDigest(locations(after, (ref) => !isText(ref, packagedPins)))
  )
    throw new EmployeeContentError('legacy_method_retired');
}

export async function assertEmployeeContentRetirement(
  organizationId: string,
  before: EmployeeContentManifest,
  after: Manifest,
  textEdits: Save['textEdits'],
  tx: ContentTx,
) {
  const refs = [before, after]
    .flatMap((manifest) => [
      ...manifest.common,
      ...manifest.scenes.flatMap((scene) => scene.references),
    ])
    .filter(
      (ref): ref is EmployeeContentReference => ref.sourceKind !== 'draft_text',
    );
  const ids = [
    ...new Set(
      refs
        .filter((ref) => ref.sourceKind === 'procedure')
        .map((ref) => ref.revisionId),
    ),
  ];
  const packages = ids.length
    ? await tx<
        { id: string; asset_id: string; digest: string; content: unknown }[]
      >`
    select r.id,r.asset_id,r.digest,r.content from allrice_company_asset_revisions r
    join allrice_company_assets a on a.id=r.asset_id and a.organization_id=r.organization_id
    where r.organization_id=${organizationId} and r.id in ${tx(ids)}
      and a.kind='procedure' and r.content->>'kind'='procedure' and r.content ? 'skillPackage'`
    : [];
  const qualify = (manifest: Manifest) =>
    new Set(
      packages.flatMap((row) => {
        const parsed = EmployeeContentTextSchema.safeParse(row.content);
        if (
          !parsed.success ||
          !('skillPackage' in parsed.data) ||
          runtimePolicyDigest(row.content) !== row.digest
        )
          return [];
        const text = parsed.data;
        const key = runtimePolicyDigest({
          sourceKind: 'procedure',
          contentId: row.asset_id,
          revisionId: row.id,
          digest: row.digest,
        });
        const scopes = [
          manifest.common,
          ...manifest.scenes.map((scene) => [
            ...manifest.common,
            ...scene.references,
          ]),
        ].filter((scope) =>
          scope.some(
            (ref) =>
              ref.sourceKind !== 'draft_text' &&
              runtimePolicyDigest(ref) === key,
          ),
        );
        try {
          for (const scope of scopes)
            validateSceneSkillPackage(
              text.skillPackage,
              text.body,
              scope.filter(
                (ref): ref is EmployeeContentReference =>
                  ref.sourceKind !== 'draft_text',
              ),
            );
          return scopes.length ? [key] : [];
        } catch {
          return [];
        }
      }),
    );
  assertEmployeeContentRetirementDelta(
    before,
    after,
    textEdits,
    qualify(after),
    qualify(before),
  );
}
