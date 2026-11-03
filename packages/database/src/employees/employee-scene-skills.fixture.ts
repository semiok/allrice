import type { SkillBundle, EmployeeContentReference } from '@allrice/contracts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';

export function sceneSkillFixture(version = '1.0.0') {
  const body = `\n# Synthetic scene ${version}\nUse the attached template.\n\n`;
  const bytes = Buffer.from('题目,来源\n例子,synthetic\n', 'utf8');
  const payload: Omit<SkillBundle, 'checksum'> = {
    schemaVersion: 1,
    version,
    contentChecksum: skillBytesChecksum(body),
    sourceRef: 'https://example.test/authored-scene',
    license: 'fixture-only',
    reviewedBy: 'synthetic publisher metadata',
    dependencies: [],
    resources: [
      {
        path: 'assets/template.csv',
        mediaType: 'text/csv',
        byteLength: bytes.length,
        checksum: skillBytesChecksum(bytes),
        contentBase64: bytes.toString('base64'),
      },
    ],
  };
  return {
    body,
    skillPackage: {
      bundle: { ...payload, checksum: skillBundleChecksum(payload) },
      resourceSources: [] as {
        path: string;
        references: EmployeeContentReference[];
      }[],
    },
  };
}
