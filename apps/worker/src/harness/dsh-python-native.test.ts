import { expect, it } from 'vitest';
import { nativeBrokerRoundtrip } from './dsh-native-broker.fixture.js';

it('exposes canonical Python location to the actual DSH model and preserves omitted runtime fields', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: {
      script: 'print("中文原始调用")',
      outputs: [{ path: '图表.png', fileName: '图表.png', format: 'png' }],
    },
    invalidArgs: { script: 'not executed', location: 'host' },
    inspectSchema(schema) {
      expect(schema.properties).toMatchObject({
        location: { enum: ['auto', 'local', 'cloud'] },
        language: { enum: ['python'] },
        script: { type: 'string' },
      });
      expect(schema.required).toContain('script');
      expect(schema.properties).not.toHaveProperty('frozenScript');
    },
  });
}, 45_000);

it('preserves an explicit local stdout-only call and rejects JavaScript before Broker', async () => {
  await nativeBrokerRoundtrip({
    canonicalName: 'python.execute',
    wireName: 'python_execute',
    args: { script: 'print(35)', location: 'local', outputs: [] },
    invalidArgs: { script: 'not executed', language: 'javascript' },
  });
}, 45_000);
