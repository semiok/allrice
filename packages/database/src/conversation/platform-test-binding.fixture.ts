import { randomUUID } from 'node:crypto';
import {
  localCommandToolchainImageV1,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeRuntimePackage,
  type PlatformEmployeeDefinition,
} from '@allrice/contracts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageChecksum,
  runtimePackageSystemPrompt,
} from '../platform-employees/runtime-package.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';
import { newNativeGeneration } from './current-execution-binding.ts';
import {
  type PlatformTestExecutionScope,
  type PlatformTestExecutionSourceInput,
  type PlatformTestPurpose,
} from './current-platform-test-binding.ts';
export function scope(): PlatformTestExecutionScope {
  return {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    testId: randomUUID(),
  };
}
function definition(): PlatformEmployeeDefinition {
  return PlatformEmployeeDefinitionSchema.parse({
    schemaVersion: 1,
    key: 'platform-binding-fixture',
    name: 'Binding fixture',
    description: 'Offline source identity fixture',
    appearance: { avatarType: 'initials', avatarValue: 'B' },
    identity: {
      role: 'Fixture',
      mission: 'Check original sources',
      workStyle: 'Return exact evidence',
      behaviorRules: ['Use authorized data only'],
      safetyBoundaries: ['No additional grants'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Preserve source identity and authorization.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'synthetic-original',
      reasoningEffort: 'high',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:synthetic',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['workspace.skill.read'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'none',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  });
}
// Fixture-only publisher resealing permits deliberate, signed-but-incompatible
// inputs. Production validation still uses the real shared publisher helpers.
function reseal(pkg: EmployeeRuntimePackage) {
  const p = pkg.runtimeManifest;
  pkg.capabilityFingerprint = runtimePackageChecksum({
    distributionGeneration: p.distributionGeneration,
    provider: p.provider,
    model: p.model,
    tools: [...p.toolNames].sort(),
    skills: pkg.skills.map((s) => ({
      name: s.name,
      checksum: s.checksum,
      requiredToolRefs: [...s.requiredToolRefs].sort(),
      ...(s.bundle ? { bundleChecksum: s.bundle.checksum } : {}),
    })),
    deniedCapabilities: [...p.deniedCapabilities].sort(),
  });
  pkg.checksum = runtimePackageChecksum({
    schemaVersion: pkg.schemaVersion,
    packageVersion: pkg.packageVersion,
    capabilityFingerprint: pkg.capabilityFingerprint,
    files: {
      identityMd: pkg.files.identityMd,
      soulMd: pkg.files.soulMd,
      userMd: pkg.files.userMd,
      agentsMd: pkg.files.agentsMd,
    },
    skills: pkg.skills,
    runtimeManifest: pkg.runtimeManifest,
  });
}
export function source(
  generation: typeof newNativeGeneration = newNativeGeneration,
  format: 'empty' | 'plain' | 'bundled' = 'plain',
  purpose: PlatformTestPurpose = 'platform_preview',
): PlatformTestExecutionSourceInput {
  const d = definition();
  const content = '# Fixture skill\nRead the reviewed resource only.\n';
  const bytes = Buffer.from('fixture-only\n');
  const bundle = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    contentChecksum: skillBytesChecksum(content),
    sourceRef: 'https://example.test/platform-binding',
    license: 'Apache-2.0',
    reviewedBy: 'fixture-reviewer',
    resources: [
      {
        path: 'references/input.txt',
        mediaType: 'text/plain',
        byteLength: bytes.length,
        checksum: skillBytesChecksum(bytes),
        contentBase64: bytes.toString('base64'),
      },
    ],
    dependencies: [
      { kind: 'tool' as const, name: 'workspace.skill.read' },
      {
        kind: 'runtime' as const,
        name: 'node' as const,
        version: '22.23.2' as const,
        imageDigest: localCommandToolchainImageV1,
      },
    ],
  };
  const skills: Parameters<typeof buildEmployeeRuntimePackage>[0]['skills'] =
    format === 'empty'
      ? []
      : [
          {
            id: randomUUID(),
            name: 'platform-binding-fixture',
            description: 'Actual publisher fixture',
            content,
            checksum: skillBytesChecksum(content),
            model_invocable: true,
            user_invocable: true,
            required_tool_refs: ['workspace.skill.read'],
            source: 'allrice',
            source_ref: bundle.sourceRef,
            version: bundle.version,
            license: bundle.license,
            review_status: 'reviewed',
            reviewed_by_label: bundle.reviewedBy,
            reviewed_at: new Date('2026-10-01T00:00:00.000Z'),
            ...(format === 'bundled'
              ? { bundle: { ...bundle, checksum: skillBundleChecksum(bundle) } }
              : {}),
          },
        ];
  d.capabilities.nativeSkillIds = skills.map((s) => s.id);
  const pkg = buildEmployeeRuntimePackage({
    revision: 7,
    definition: d,
    skills,
  });
  if (generation !== newNativeGeneration) {
    pkg.runtimeManifest.distributionGeneration = generation;
    reseal(pkg);
  }
  const profile = PlatformEmployeeRuntimeProfileSchema.parse({
    schemaVersion: 1,
    harness: 'dsh',
    distributionGeneration: generation,
    employeeKey: d.key,
    provider: d.modelPolicy.provider,
    model: d.modelPolicy.model,
    reasoningEffort: d.modelPolicy.reasoningEffort,
    timeoutMs: d.modelPolicy.timeoutMs,
    credentialReference: d.modelPolicy.credentialReference,
    baseUrl: d.modelPolicy.baseUrl,
    systemPrompt: runtimePackageSystemPrompt({
      platformPolicy: d.systemPrompt,
      runtimePackage: pkg,
    }),
    nativeSkillIds: pkg.skills.map((s) => s.id),
    nativeSkillChecksums: pkg.skills.map((s) => s.checksum),
    toolNames: d.capabilities.toolNames,
    connectorRefs: d.capabilities.connectorRefs,
    securityPolicy: d.securityPolicy,
    runtimePackage: pkg,
  });
  return {
    platformEmployeeId: randomUUID(),
    platformRevisionId: randomUUID(),
    purpose,
    definitionChecksum: runtimePackageChecksum(d),
    definition: d,
    runtimeProfile: profile,
    nativeSkills: pkg.skills,
    packageChecksum: pkg.checksum,
  };
}
