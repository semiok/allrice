import {
  EmployeeRuntimeSceneSchema,
  type EmployeeRuntimeContent,
} from '@allrice/contracts';
import { runtimePolicyDigest } from '../runtime-policy.ts';

export function employeeRuntimeScenes(snapshot: EmployeeRuntimeContent) {
  const scenes = new Map<
    string,
    {
      id: string;
      name: string;
      appliesWhen: string;
      members: unknown[];
    }
  >();
  const references = new Set<string>();
  const addRefs = (refs: EmployeeRuntimeContent['layers'][number]['common']) =>
    refs.forEach((r) =>
      references.add(
        `${r.sourceKind}:${r.contentId}:${r.revisionId}:${r.digest}`,
      ),
    );
  for (const layer of snapshot.layers) {
    addRefs(layer.common);
    const seen = new Set<string>();
    for (const scene of layer.scenes ?? []) {
      if (seen.has(scene.id)) throw Error('duplicate_runtime_scene');
      seen.add(scene.id);
      addRefs(scene.references);
      const current = scenes.get(scene.id);
      if (
        current &&
        (current.name !== scene.name ||
          current.appliesWhen !== scene.appliesWhen)
      )
        throw Error('ambiguous_runtime_scene_identity');
      const next = current ?? {
        id: scene.id,
        name: scene.name,
        appliesWhen: scene.appliesWhen,
        members: [],
      };
      next.members.push({
        setId: layer.setId,
        revisionId: layer.revisionId,
        digest: layer.digest,
        ownership: layer.ownership,
        references: scene.references,
      });
      scenes.set(scene.id, next);
    }
  }
  if (scenes.size > 16 || references.size > 128)
    throw Error('runtime_scene_directory_limit');
  return [...scenes.values()].map((scene) =>
    EmployeeRuntimeSceneSchema.parse({
      id: scene.id,
      name: scene.name,
      appliesWhen: scene.appliesWhen,
      nativeName: `allrice-scene-${scene.id}`,
      digest: runtimePolicyDigest(scene),
    }),
  );
}
