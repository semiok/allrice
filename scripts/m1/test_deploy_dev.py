# Unit tests for scripts/m1/deploy-dev (MET-221 PR2b-0): the migration gate that knows a
# release's archived migrations, and the pre-migration snapshot. deploy-dev is sourced for
# its functions in a fake HOME with psql and pg_dump stubbed; a release's
# migration-compatibility.js is imported by the real node.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import gzip
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY_DEV = os.path.join(HERE, 'deploy-dev')
_pinned = os.path.expanduser('~/.local/opt/node-22.23.2/bin/node')
NODE = _pinned if os.path.exists(_pinned) else shutil.which('node')
ARCHIVED = [
    '0073_gemini_model_provider.sql',
    '0213_native_chat_executor_transitions.sql',
    '0214_native_control_cloud_absence.sql',
    '0215_terminal_native_test_retirements.sql',
    '0216_native_legacy_chat_adoption.sql',
]
FILES = ['0001_baseline.sql', '0073_runtime_operation_ledger.sql', '0212_dsh_runtime_close_observations.sql',
         '0217_brand_content_feedback.sql', '0218_native_generation_binding.sql']


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, mode)


@unittest.skipUnless(NODE, 'node is not installed')
class DeployDevMigrations(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='deploy-dev-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        for role in ('web', 'worker'):
            path = os.path.join(self.home, 'Library/LaunchAgents/ai.bplabs.allrice-dev-%s.plist' % role)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                plistlib.dump({'Label': role, 'WorkingDirectory': '/nowhere', 'EnvironmentVariables': {
                    'DATABASE_URL': 'postgres://stub/allrice_dev', 'ALLRICE_WEB_PORT': '1', 'ALLRICE_WORKER_PORT': '2'}}, f)
        write(os.path.join(self.home, 'allrice-dev/.env'), 'ALLRICE_TEST=1\n', 0o600)
        local = os.path.join(self.home, 'allrice-dev/.local')
        write(os.path.join(local, 'storage/org/file.txt'), 'stored')
        write(os.path.join(local, 'dsh-runtime-m1/rt/journal.jsonl'), '{"v":1}\n')
        write(os.path.join(local, 'bridge/big.bin'), 'not snapshotted')
        self.stubs = os.path.join(self.tmp, 'stubs')
        self.applied = os.path.join(self.tmp, 'applied.txt')
        # $CONTRACT_FILE holds psql's answer for the journal contract row ('row:<highWater>', empty: no row).
        write(os.path.join(self.stubs, 'psql'), '#!/bin/sh\n[ -z "$PSQL_FAIL" ] || exit 2\nfor a; do q=$a; done\n'
              'case "$q" in *allrice_runtime_metadata*) cat "$CONTRACT_FILE" 2>/dev/null ;; *) cat "$APPLIED" ;; esac\n', 0o755)
        write(os.path.join(self.stubs, 'pg_dump'), '#!/bin/sh\n[ -z "$PG_DUMP_FAIL" ] || exit 1\necho "-- dump of $*"\n', 0o755)
        if sys.platform != 'darwin':  # GNU cp has no clonefile flag
            write(os.path.join(self.stubs, 'cp'), '#!/bin/sh\n[ "$1" != -c ] || shift\nexec /bin/cp "$@"\n', 0o755)
        self.snapshots = os.path.join(self.home, 'allrice-dev/qa/pre-migrate')

    def release(self, files=FILES, archived=ARCHIVED, module=None, store=True):
        rel = tempfile.mkdtemp(prefix='rel-', dir=self.tmp)
        db = os.path.join(rel, 'packages/database')
        for name in files:
            write(os.path.join(db, 'migrations', name), '-- %s\n' % name)
        write(os.path.join(db, 'migrations/README.md'), 'not a migration')
        write(os.path.join(db, 'package.json'), '{"type":"module"}\n')
        if module is None:
            module = 'export const archivedMigrationNames = %s;\nexport function migrationsMatch() {}\n' % archived
        if module is not False:
            write(os.path.join(db, 'dist/migration-compatibility.js'), module)
        # Importing anything else would be a bug: migrate.js runs migrations when it loads.
        write(os.path.join(db, 'dist/migrate.js'), 'throw new Error("migrate.js was imported");\n')
        if store:  # releases from MET-221 PR2b-1 on know the journal contract high water
            write(os.path.join(db, 'dist/native-journal-contract-store.js'), 'export {};\n')
        return rel

    def run_dd(self, script, applied, CONTRACT='', **env):
        write(self.applied, ''.join(n + '\n' for n in applied))
        env['CONTRACT_FILE'] = os.path.join(self.tmp, 'contract.txt')
        write(env['CONTRACT_FILE'], CONTRACT)
        path = ':'.join([self.stubs, os.path.dirname(NODE), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])
        env = dict(HOME=self.home, PATH=path, TEST_PATH=path, APPLIED=self.applied, **env)
        return subprocess.run(['/bin/bash', '-c', 'source "$1"; PATH=$TEST_PATH; inflight_phase() { :; }; ' + script,
                               'test', DEPLOY_DEV], env=env, capture_output=True, text=True, timeout=60)

    def check(self, rel, applied):  # -> (known, printed)
        p = self.run_dd('if out=$(check_migrations_known "$REL"); then echo "OK $out"; else echo "REFUSED $out"; fi',
                        applied, REL=rel)
        self.assertEqual(p.returncode, 0, p.stderr)
        verdict, _, printed = p.stdout.strip().partition(' ')
        return verdict == 'OK', printed

    def test_archived_names_are_known(self):
        known, pending = self.check(self.release(), FILES + ARCHIVED)
        self.assertTrue(known)
        self.assertEqual(pending, '')

    def test_names_that_differ_slightly_are_refused(self):
        rel = self.release()
        for near in ('0213_x.sql', '0213_native_chat_executor_transition.sql', '0214_native_control_cloud_absence.sq',
                     '0215_Terminal_native_test_retirements.sql', ' 0216_native_legacy_chat_adoption.sql', 'README.md'):
            with self.subTest(near=near):
                known, printed = self.check(rel, FILES + ARCHIVED[:1] + [near])
                self.assertFalse(known)
                self.assertIn(near.strip(), printed)

    def test_unarchived_deleted_migration_is_refused(self):
        known, printed = self.check(self.release(archived=ARCHIVED[:1]), FILES + ARCHIVED)
        self.assertFalse(known)
        self.assertIn('0213_native_chat_executor_transitions.sql', printed)

    def test_unreadable_archive_list_refuses(self):
        for module in (False, 'export const somethingElse = [];\n', 'export const archivedMigrationNames = ["../x"];\n',
                       'import "./migrate.js";\nexport const archivedMigrationNames = [];\n'):
            with self.subTest(module=module):
                known, printed = self.check(self.release(module=module), FILES)
                self.assertFalse(known)
                self.assertIn('cannot read archivedMigrationNames', printed)

    def test_unreadable_database_refuses(self):
        p = self.run_dd('check_migrations_known "$REL" || echo "REFUSED"', FILES, REL=self.release(), PSQL_FAIL='1')
        self.assertIn('cannot read allrice_schema_migrations', p.stdout)
        self.assertIn('REFUSED', p.stdout)

    def test_pending_migrations_are_listed(self):
        known, pending = self.check(self.release(), FILES[:-1] + ARCHIVED)
        self.assertTrue(known)
        self.assertEqual(pending, '0218_native_generation_binding.sql')

    def snapshot(self, applied, forced='0', name='20261026-1800-abcdef12', **env):
        return self.run_dd('pending=$(check_migrations_known "$REL"); pre_migrate_snapshot "$NAME" "$pending" "$FORCED"',
                           applied, REL=self.release(), NAME=name, FORCED=forced, **env)

    def test_no_snapshot_without_migrations(self):
        p = self.snapshot(FILES + ARCHIVED)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('no migrations to apply; no snapshot', p.stdout)
        self.assertFalse(os.path.exists(self.snapshots))

    def assert_snapshot(self, name):
        d = os.path.join(self.snapshots, name)
        self.assertEqual(sorted(os.listdir(d)), ['allrice_dev.sql.gz', 'dsh-runtime-m1', 'env', 'storage', 'web.plist', 'worker.plist'])
        with gzip.open(os.path.join(d, 'allrice_dev.sql.gz'), 'rt') as f:
            self.assertEqual(f.read(), '-- dump of -Fp --no-owner --no-privileges postgres://stub/allrice_dev\n')
        with open(os.path.join(d, 'storage/org/file.txt')) as f:
            self.assertEqual(f.read(), 'stored')
        self.assertEqual(os.stat(os.path.join(d, 'env')).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)

    def test_snapshot_before_pending_migrations(self):
        p = self.snapshot(FILES[:-1] + ARCHIVED)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('to apply: 0218_native_generation_binding.sql', p.stdout)
        self.assert_snapshot('20261026-1800-abcdef12')

    def test_forced_snapshot_without_migrations(self):
        p = self.snapshot(FILES + ARCHIVED, forced='1')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('forced; no migrations to apply', p.stdout)
        self.assert_snapshot('20261026-1800-abcdef12')

    def test_keeps_the_newest_two_snapshots(self):
        for name in ('20261026-1000-aaaaaaaa', '20261026-1200-cccccccc', '20261026-1100-bbbbbbbb'):
            self.assertEqual(self.snapshot(FILES + ARCHIVED, forced='1', name=name).returncode, 0)
        self.assertEqual(sorted(os.listdir(self.snapshots)), ['20261026-1100-bbbbbbbb', '20261026-1200-cccccccc'])

    def test_pruning_is_best_effort_and_clears_leftovers(self):
        for name in ('20261026-1000-aaaaaaaa/ro', '20261026-1100-bbbbbbbb', '20261026-0900-killed.tmp'):
            os.makedirs(os.path.join(self.snapshots, name))
        locked = os.path.join(self.snapshots, '20261026-1000-aaaaaaaa/ro')
        write(os.path.join(locked, 'f'), 'x')
        os.chmod(locked, 0o555)  # rm -rf cannot empty it
        self.addCleanup(os.chmod, locked, 0o755)
        p = self.snapshot(FILES + ARCHIVED, forced='1', name='20261026-1200-cccccccc')
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('could not prune', p.stderr)
        self.assertEqual(sorted(os.listdir(self.snapshots)), ['20261026-1000-aaaaaaaa', '20261026-1100-bbbbbbbb', '20261026-1200-cccccccc'])

    def precheck(self, output, earlier=''):
        rel = self.release()
        write(os.path.join(rel, 'scripts/dev-release/verify-native-retention.mjs'),
              'console.error(%s); process.exit(1);\n' % json.dumps(output))
        log = os.path.join(self.tmp, 'deploy.log')
        write(log, earlier)
        p = self.run_dd('precheck "$REL" sha art "$PLOG" || echo "REFUSED"', [], REL=rel, PLOG=log)
        self.assertIn('REFUSED', p.stdout, p.stderr)
        return p.stdout

    def test_precheck_names_the_failure(self):
        cases = [
            ('Error: DSH_NATIVE_CONTEXT_INCOMPATIBLE [chat 1 generation]', 'incompatible with this version'),
            ('Error: DSH_NATIVE_JOURNAL_CONTRACT_AHEAD [2 > 1]', 'journal contract range does not cover'),
            ('error: relation "allrice_new_table" does not exist', 'a defect, the checker must run on the schema before'),
            ('Error: DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED [INCOMPATIBLE-looking detail]', 'does not cover'),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                self.assertIn(expected, self.precheck(output))
        # Text from earlier in the deploy log (the build) is not this check's failure.
        out = self.precheck('Error: DSH_NATIVE_SOMETHING_ELSE', earlier='relation "x" does not exist\n')
        self.assertIn('pre-stop native check failed: DSH_NATIVE_SOMETHING_ELSE', out)

    def contract(self, rel, high_water, **env):
        p = self.run_dd('if out=$(check_contract_known "$REL"); then echo "OK"; else echo "REFUSED $out"; fi',
                        FILES + ARCHIVED, REL=rel, CONTRACT=high_water, **env)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def test_journals_above_contract_1_need_a_release_that_knows_the_contract(self):
        old, new = self.release(store=False), self.release()
        self.assertIn('predates the journal contract', self.contract(old, 'row:2'))
        self.assertEqual(self.contract(new, 'row:2'), 'OK')
        for row in ('', 'row:1'):  # no row yet, or the PR2b-1 baseline
            with self.subTest(row=row):
                self.assertEqual(self.contract(old, row), 'OK')
        for row in ('row:', 'row:0', 'row:01', 'row:2.5', 'row:1234567890', 'row:invalid 2', 'row:invalid {"highWater": "2"}'):
            with self.subTest(row=row):  # a row that is there but not the store's shape
                self.assertIn('unreadable journal contract row', self.contract(new, row))
        self.assertIn('cannot read the journal contract', self.contract(new, 'row:2', PSQL_FAIL='1'))

    def test_status_shows_whether_a_rollback_would_pass(self):
        old = self.release(store=False)
        write(os.path.join(self.home, 'allrice-dev/qa/.previous-release'), old + '\n/nowhere\n')
        for high_water, expected in (('1', 'it predates the journal contract, fine while the journals are at contract 1'),
                                     ('2', 'would be REFUSED: the journals reach contract 2')):
            with self.subTest(high_water=high_water):
                p = self.run_dd('status', FILES + ARCHIVED, CONTRACT='row:' + high_water)
                self.assertEqual(p.returncode, 0, p.stderr)
                self.assertIn('journal contract:   high water %s' % high_water, p.stdout)
                self.assertIn(expected, p.stdout)

    # Flow tests: everything that would build, lock or touch launchd is stubbed; STOPPED in
    # the output means the run got as far as stopping Dev.
    FLOW_STUBS = ('precheck() { echo PRECHECK >&2; [ -z "${RAISE:-}" ] || printf %s "$RAISE" > "$CONTRACT_FILE"; }; '
                  'take_lock() { echo LOCKED; }; '
                  'inflight_begin() { :; }; stop_both() { echo STOPPED; return 1; }; ')

    def test_rollback_checks_the_contract_before_stopping_and_again_under_the_lock(self):
        old = self.release(store=False)
        write(os.path.join(self.home, 'allrice-dev/qa/deploys.jsonl'),
              json.dumps({'kind': 'deploy', 'toRelease': old, 'toSha': 'a' * 40, 'toArtifact': 'sha256:' + 'a' * 64}) + '\n')
        run = lambda **env: self.run_dd(self.FLOW_STUBS + 'rollback "$OLD"', FILES + ARCHIVED, OLD=old, **env)
        p = run(CONTRACT='row:2')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('predates the journal contract', p.stderr)
        self.assertNotIn('PRECHECK', p.stderr)
        p = run(CONTRACT='row:1', RAISE='row:2')  # a deploy raised it while the pre-stop check ran
        self.assertIn('LOCKED', p.stdout)
        self.assertIn('predates the journal contract', p.stderr)
        self.assertNotIn('STOPPED', p.stdout)
        self.assertIn('STOPPED', run(CONTRACT='row:1').stdout)

    def test_deploy_refuses_an_old_candidate_before_stopping(self):
        old = self.release(store=False)
        stubs = self.FLOW_STUBS + (
            'df() { printf "h\\nx x x 100\\n"; }; resolve_ref() { echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; }; '
            'git() { [ "$3 $4" != "worktree add" ] || { mkdir -p "$(dirname "$7")" && cp -R "$OLD" "$7"; }; }; pnpm() { :; }; '
            'node() { case "$1" in apps/*) echo \'{"artifactId":"sha256:%s"}\' ;; scripts/*) : ;; *) command node "$@" ;; esac; }; '
            % ('c' * 64))
        for high_water, stopped in (('2', False), ('1', True)):
            with self.subTest(high_water=high_water):
                p = self.run_dd(stubs + 'deploy --skip-smoke', FILES + ARCHIVED, OLD=old, CONTRACT='row:' + high_water)
                self.assertIn('PRECHECK', p.stderr)
                self.assertEqual('STOPPED' in p.stdout, stopped, p.stderr)
                if not stopped:
                    self.assertIn('predates the journal contract', p.stderr)
                    with open(os.path.join(self.home, 'allrice-dev/qa/deploys.jsonl')) as f:
                        self.assertIn('"phase": "contract"', f.read())
                shutil.rmtree(os.path.join(self.home, 'allrice-dev-releases'), True)

    def saved_release(self, old):
        inflight = os.path.join(self.home, 'allrice-dev/qa/deploy-inflight')
        for role in ('web', 'worker'):  # the launchd files saved before the deploy point at the old release
            os.makedirs(inflight, exist_ok=True)
            with open(os.path.join(inflight, role + '.plist'), 'wb') as f:
                plistlib.dump({'Label': role, 'WorkingDirectory': old, 'EnvironmentVariables': {
                    'DATABASE_URL': 'postgres://stub/allrice_dev', 'ALLRICE_WEB_PORT': '1', 'ALLRICE_WORKER_PORT': '2'}}, f)
        write(os.path.join(inflight, 'state'), 'switching\n' + 'a' * 40 + '\n')

    def test_failed_deploy_does_not_restore_a_version_that_cannot_read_the_journals(self):
        self.saved_release(self.release(store=False))
        script = 'stop_both() { :; }; start_both_on() { echo STARTED; }; if restore; then echo restore=0; else echo restore=1; fi'
        cases = (('row:2', {}, False), ('row:1', {}, True), ('row:2', {'PSQL_FAIL': '1'}, False), ('row:invalid 2', {}, True))
        for row, env, started in cases:  # migration reads now fail closed; the contract policy is unchanged
            with self.subTest(row=row, env=env):
                p = self.run_dd(script, FILES + ARCHIVED, CONTRACT=row, **env)
                self.assertEqual('STARTED' in p.stdout, started, p.stdout)
                self.assertIn('restore=%d' % (0 if started else 1), p.stdout)
                if not started and not env:
                    self.assertIn('not starting aaaaaaaa: the journals reach contract 2', p.stdout)

    def test_automatic_restore_and_recover_refuse_committed_unknown_migrations(self):
        old = self.release(files=FILES[:-1])
        for entry in ('INFLIGHT_MINE=1; on_exit 1', 'recover'):
            for unreadable in (False, True):
                with self.subTest(entry=entry, unreadable=unreadable):
                    self.saved_release(old)
                    log = os.path.join(self.home, 'allrice-dev/qa/deploys.jsonl')
                    write(log, '')
                    script = ('take_lock() { :; }; stop_both() { echo STOPPED; }; '
                              'start_both_on() { echo STARTED; }; ' + entry)
                    p = self.run_dd(script, FILES + ARCHIVED, CONTRACT='row:1',
                                    **({'PSQL_FAIL': '1'} if unreadable else {}))
                    self.assertNotEqual(p.returncode, 0)
                    self.assertIn('STOPPED', p.stdout)
                    self.assertNotIn('STARTED', p.stdout)
                    self.assertNotIn('is healthy again', p.stdout)
                    self.assertIn('migrations have committed', p.stdout)
                    self.assertIn('previous version is incompatible', p.stdout)
                    self.assertIn('Services remain stopped', p.stdout)
                    self.assertIn('docs/runbooks/m1-database.md or fix forward', p.stdout)
                    self.assertIn('cannot read allrice_schema_migrations' if unreadable else FILES[-1], p.stdout)
                    self.assertTrue(os.path.isfile(os.path.join(self.home, 'allrice-dev/qa/deploy-inflight/state')))
                    with open(log) as f:
                        records = [json.loads(line) for line in f]
                    self.assertTrue(any(r.get('kind') == 'failed' and r.get('restored') == 'no'
                                        and r.get('manualIntervention') == 'required' for r in records))

    def test_restore_and_recover_start_a_known_version_after_a_transaction_rollback_or_snapshot_restore(self):
        for entry in ('INFLIGHT_MINE=1; on_exit 1', 'recover'):
            for applied, files in ((FILES[:-1] + ARCHIVED, FILES[:-1]), (FILES + ARCHIVED, FILES)):
                with self.subTest(entry=entry, files=files):
                    self.saved_release(self.release(files=files))
                    p = self.run_dd('take_lock() { :; }; stop_both() { echo STOPPED; }; '
                                    'start_both_on() { echo STARTED; }; ' + entry, applied, CONTRACT='row:1')
                    self.assertEqual(p.returncode, 1 if 'on_exit' in entry else 0, p.stderr)
                    self.assertIn('STARTED', p.stdout)
                    self.assertIn('is healthy again', p.stdout)
                    self.assertFalse(os.path.exists(os.path.join(self.home, 'allrice-dev/qa/deploy-inflight')))

    def test_rollback_refuses_unknown_migrations_before_stop_and_rechecks_under_lock(self):
        old = self.release(files=FILES[:-1])
        write(os.path.join(self.home, 'allrice-dev/qa/deploys.jsonl'),
              json.dumps({'kind': 'deploy', 'toRelease': old, 'toSha': 'a' * 40, 'toArtifact': 'sha256:' + 'a' * 64}) + '\n')
        for applied, race in ((FILES + ARCHIVED, False), (FILES[:-1] + ARCHIVED, True)):
            with self.subTest(race=race):
                stubs = self.FLOW_STUBS
                if race:
                    stubs += 'precheck() { echo PRECHECK; echo 0218_native_generation_binding.sql >> "$APPLIED"; }; '
                p = self.run_dd(stubs + 'rollback "$OLD"', applied, OLD=old, CONTRACT='row:1')
                self.assertNotEqual(p.returncode, 0)
                self.assertIn(FILES[-1], p.stderr)
                self.assertNotIn('STOPPED', p.stdout)
                self.assertEqual('LOCKED' in p.stdout, race)

    def test_failed_snapshot_stops_the_deploy(self):
        p = self.snapshot(FILES[:-1] + ARCHIVED, PG_DUMP_FAIL='1')
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('FAILED: pre-migration snapshot failed', p.stderr)
        self.assertEqual(os.listdir(self.snapshots), [])

    def test_unready_worker_does_not_stop_the_deploy(self):
        # Nothing listens on the plist's Worker port: no boot id, and set -e must not abort.
        p = self.run_dd('boot=$(worker_boot); echo "boot=[$boot]"', [])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('boot=[]', p.stdout)

    def test_after_stop_report_never_fails(self):
        p = self.run_dd('report_after_stop 11111111-2222-3333-4444-555555555555; echo "rc=$?"', [], PSQL_FAIL='1')
        self.assertIn('after stop (diagnostic, not a gate)', p.stdout)
        self.assertIn('rc=0', p.stdout)


if __name__ == '__main__':
    unittest.main()
