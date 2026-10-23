/** Isolated migration guard only; not an issuer, lease or model acceptance. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { source, scope } from './platform-test-binding.fixture.ts';
import {
  freezePlatformTestExecutionBinding,
  newCurrentPlatformTestOrigin,
} from './current-platform-test-binding.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'new platform test binding migration guards in a private complete schema',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let originalHistory: unknown;
    const own = scope(),
      s = source(undefined, 'empty');
    const historicalId = randomUUID();
    const input = {
      environment: 'company',
      workspaceId: own.workspaceId,
      ownerId: own.ownerId,
      prompt: 'Synthetic only',
    };
    beforeAll(async () => {
      vi.stubEnv(
        'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
        'sha256:' + 'a'.repeat(64),
      );
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', 'sha256:' + 'a'.repeat(64));
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        Error('No network from migration fixture'),
      );
      f = await createAssistantFixtureDatabase({
        throughMigration: '0210_current_employee_execution_binding.sql',
      });
      const db = f.db;
      const [where] =
        await db`select current_database() db,current_schema() schema`;
      expect(where!.db).toBe('allrice_b2');
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      await db`insert into allrice_users(id,email,display_name,password_hash) values(${own.ownerId},${own.ownerId + '@example.test'},'Synthetic','not-a-login')`;
      await db`insert into allrice_organizations(id,slug,name) values(${own.organizationId},${own.organizationId},'Synthetic')`;
      await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${own.workspaceId},${own.organizationId},'default','Synthetic')`;
      await db`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${s.platformEmployeeId},${s.platformEmployeeId},'Synthetic','Guard fixture','draft')`;
      await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum,runtime_profile)
      values(${s.platformRevisionId},${s.platformEmployeeId},1,'testing',${db.json(s.definition as never)},${s.definitionChecksum},${db.json(s.runtimeProfile as never)})`;
      await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum)
      values(${historicalId},${s.platformEmployeeId},${s.platformRevisionId},'fixture','queued',${db.json(input)},${db.json(s.runtimeProfile as never)},${db.json(s.definition as never)},${db.json(s.nativeSkills as never)},${s.packageChecksum})`;
      const [history] =
        await db`select to_jsonb(t) value from allrice_platform_employee_test_runs t where id=${historicalId}`;
      originalHistory = history!.value;
      const migration = new URL(
        '../../migrations/0211_current_platform_test_execution_binding.sql',
        import.meta.url,
      );
      await db.unsafe(await readFile(migration, 'utf8'));
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      const proof = await f?.close();
      console.log(
        JSON.stringify({ kind: 'b2a-migration-fixture-cleanup', proof }),
      );
    });
    function birth() {
      const scope = { ...own, testId: randomUUID() },
        origin = newCurrentPlatformTestOrigin({ scope, source: s });
      return {
        id: scope.testId,
        origin,
        binding: freezePlatformTestExecutionBinding({
          origin,
          scope,
          source: s,
        }),
      };
    }
    async function insert(
      value: ReturnType<typeof birth>,
      overrides: {
        origin?: unknown;
        binding?: unknown;
        input?: unknown;
        purpose?: string;
      } = {},
    ) {
      const db = f.db;
      const origin = 'origin' in overrides ? overrides.origin : value.origin;
      const binding =
        'binding' in overrides ? overrides.binding : value.binding;
      return db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose,frozen_runtime_profile,frozen_definition,frozen_native_skills,frozen_package_checksum,native_root_origin,native_execution_binding)
      values(${value.id},${s.platformEmployeeId},${s.platformRevisionId},'fixture','queued',${db.json((overrides.input ?? input) as never)},${overrides.purpose ?? 'platform_preview'},
      ${db.json(s.runtimeProfile as never)},${db.json(s.definition as never)},${db.json(s.nativeSkills as never)},${s.packageChecksum},${origin == null ? null : db.json(origin as never)},${binding == null ? null : db.json(binding as never)})`;
    }
    it('does not rewrite historical rows or synthesize their binding', async () => {
      const [row] =
        await f.db`select to_jsonb(t)-'native_execution_binding' value,native_execution_binding from allrice_platform_employee_test_runs t where id=${historicalId}`;
      expect(row!.value).toEqual(originalHistory);
      expect(row!.native_execution_binding).toBeNull();
      await expect(
        f.db`update allrice_platform_employee_test_runs set native_execution_binding=${f.db.json(birth().binding)} where id=${historicalId}`,
      ).rejects.toThrow('immutable');
    });
    it('accepts a consistent current first INSERT and allows execution status updates', async () => {
      const b = birth();
      await insert(b);
      await f.db`update allrice_platform_employee_test_runs set status='running',started_at=clock_timestamp(),timeout_at=clock_timestamp()+interval '1 minute' where id=${b.id}`;
      const [row] =
        await f.db`select status,native_root_origin,native_execution_binding from allrice_platform_employee_test_runs where id=${b.id}`;
      expect(row!.status).toBe('running');
      expect(row!.native_root_origin).toEqual(b.origin);
      expect(row!.native_execution_binding).toEqual(b.binding);
    });
    it('rejects a V2 birth with no binding and rolls back the INSERT', async () => {
      const b = birth();
      await expect(insert(b, { binding: null })).rejects.toThrow(
        'binding required',
      );
      expect(
        await f.db`select 1 from allrice_platform_employee_test_runs where id=${b.id}`,
      ).toHaveLength(0);
    });
    it('rejects attaching a current binding to historical NULL origin', async () => {
      await expect(insert(birth(), { origin: null })).rejects.toThrow(
        'cannot be rebound',
      );
    });
    it.each(['artifactId', 'generation', 'profileId'] as const)(
      'rejects mismatched executor %s',
      async (key) => {
        const b = birth(),
          altered = structuredClone(b.binding);
        (altered.execution as Record<string, unknown>)[key] =
          key === 'artifactId' ? 'sha256:' + 'b'.repeat(64) : 'wrong';
        await expect(insert(b, { binding: altered })).rejects.toThrow(
          'binding required',
        );
      },
    );
    it.each(['organizationId', 'workspaceId', 'ownerId', 'testId'] as const)(
      'rejects mismatched binding scope %s',
      async (key) => {
        const b = birth(),
          altered = structuredClone(b.binding);
        altered.scope[key] = randomUUID();
        await expect(insert(b, { binding: altered })).rejects.toThrow(
          'binding required',
        );
      },
    );
    it('rejects wrong source purpose and missing input owner', async () => {
      await expect(
        insert(birth(), { purpose: 'method_candidate' }),
      ).rejects.toThrow('binding required');
      await expect(
        insert(birth(), { input: { ...input, ownerId: null } }),
      ).rejects.toThrow('binding required');
    });
    it('preserves both origin and binding immutability', async () => {
      const b = birth();
      await insert(b);
      await expect(
        f.db`update allrice_platform_employee_test_runs set native_root_origin=null where id=${b.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_platform_employee_test_runs set native_execution_binding=null where id=${b.id}`,
      ).rejects.toThrow('immutable');
    });
    it.each([
      'frozen_definition',
      'frozen_runtime_profile',
      'frozen_native_skills',
    ] as const)('blocks current frozen input replacement %s', async (key) => {
      const b = birth();
      await insert(b);
      await expect(
        f.db`update allrice_platform_employee_test_runs set ${f.db(key)}='null'::jsonb where id=${b.id}`,
      ).rejects.toThrow('source is immutable');
    });
  },
);
