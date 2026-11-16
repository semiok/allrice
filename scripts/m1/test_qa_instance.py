# Exercise the production cmd_up in a private HOME. Only external commands and
# port availability are stubbed; no PostgreSQL, launchd, network or live QA state.
# CI collects this with python3 -m unittest discover -s scripts/m1 -p 'test_*.py'.
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_SHA = 'a' * 40
ARTIFACT_ID = 'sha256:' + 'b' * 64

COMMAND_STUB = '''#!/usr/bin/python3
import json, os, sys, shutil, fcntl
from pathlib import Path
command, args = Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ['QA_TEST_EVENTS'], 'a') as f:
    f.write(json.dumps({'command': command, 'args': args, 'cwd': os.getcwd()}) + '\\n')
if command == 'git':
    if 'rev-parse' in args:
        print('a' * 40)
    elif 'worktree' in args and 'add' in args:
        release = Path(args[-2])
        (release / 'scripts/m1').mkdir(parents=True)
        if not os.environ.get('QA_TEST_MISSING_RICE'):
            (release / 'scripts/m1/rice-standard.json').write_text('{"version":"ref","toolNames":["memory.search"]}')
elif command == 'node':
    if args[0].endswith('/prepare-native-artifact.mjs'):
        print(json.dumps({'artifactId': 'sha256:' + 'b' * 64}))
    elif args[0].endswith('/prepare-identity.mjs') and os.environ.get('QA_TEST_IDENTITY_FAIL'):
        sys.exit(42)
    elif args[0].endswith('/qa-bootstrap.mjs'):
        template = args[args.index('--rice') + 1] if '--rice' in args else str(Path(args[0]).with_name('rice-standard.json'))
        if json.loads(Path(template).read_text()).get('version') != 'ref':
            sys.exit(43)
elif command == 'launchctl' and args[0] == 'print':
    if any(name in args[-1] for name in os.environ.get('QA_TEST_LIVE', '').split(',') if name):
        print('state = running\\npid = 12345')
    else:
        sys.exit(113)
elif command == 'lsof':
    print('p999999\\nfcwd\\nn/private/tmp/unrelated')
elif command == 'ps':
    print('999999 1 node /tmp/unrelated.mjs')
elif command == 'sleep' and os.environ.get('QA_TEST_RELEASE'):
    # The waiting process must release the allocator so an owner can down.
    with open(Path.home() / 'allrice-qa/.alloc.lock', 'rb') as f:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        shutil.rmtree(Path.home() / 'allrice-qa' / os.environ['QA_TEST_RELEASE'])
elif command not in ('pnpm', 'psql', 'dropdb', 'createdb', 'launchctl', 'curl'):
    sys.exit(99)
'''


class QaInstanceBuildIdentity(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='qa-instance-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, 'home')
        self.release = os.path.join(self.home, 'allrice-qa/met-218-test/release')
        self.events = os.path.join(self.tmp, 'events.jsonl')
        node_bin = os.path.join(self.home, '.local/opt/node-22.23.2/bin')
        os.makedirs(node_bin)
        for name in ('git', 'pnpm', 'node', 'psql', 'dropdb', 'createdb', 'launchctl', 'curl', 'lsof', 'ps', 'sleep'):
            path = os.path.join(node_bin, name)
            with open(path, 'w') as f:
                f.write(COMMAND_STUB)
            os.chmod(path, 0o755)
        # Keep cmd_up unchanged, replacing only the host port probe. Its actual
        # allocation lock, file writes, plist generation and error exits run.
        with open(os.path.join(HERE, 'qa-instance')) as f:
            definitions, marker, dispatch = f.read().partition('\ncase "${1:-}" in')
        self.assertTrue(marker, 'qa-instance command dispatch marker changed')
        self.script = os.path.join(self.tmp, 'qa-instance')
        with open(self.script, 'w') as f:
            f.write(definitions + '\nport_busy() { return 1; }\ncmd_up "$@"\n')
        shutil.copyfile(os.path.join(HERE, 'lib.sh'), os.path.join(self.tmp, 'lib.sh'))
        shutil.copyfile(os.path.join(HERE, 'qa-lease.py'), os.path.join(self.tmp, 'qa-lease.py'))
        Path(self.tmp, 'rice-standard.json').write_text('{"version":"installed-old","toolNames":["workspace.memory.search"]}')
        self.dispatch_script = os.path.join(self.tmp, 'qa-instance-cli')
        Path(self.dispatch_script).write_text(definitions + '\nport_busy() { return 1; }\n' + marker + dispatch)
        dev = os.path.join(self.home, 'allrice-dev')
        os.makedirs(dev)
        with open(os.path.join(dev, '.env'), 'w') as f:
            f.write('DATABASE_URL=postgres://stub/allrice_dev\nUNRELATED_SETTING=keep\n')
        agents = os.path.join(self.home, 'Library/LaunchAgents')
        os.makedirs(agents)
        for role in ('web', 'worker'):
            with open(os.path.join(agents, 'ai.bplabs.allrice-dev-' + role + '.plist'), 'wb') as f:
                plistlib.dump({
                    'ProgramArguments': [os.path.join(node_bin, 'node'), '--env-file=/unused', '/unused'],
                    'EnvironmentVariables': {
                        'ALLRICE_DEV_MAINTENANCE_ENABLED': '1',
                        'ALLRICE_CLOUD_RUNNER_ENABLED': '1',
                        'ALLRICE_CLOUD_MCP_ENABLED': '1',
                        'UNRELATED_SETTING': 'keep',
                    },
                }, f)

    def up(self, identity_fail=False):
        env = dict(os.environ, HOME=self.home, USER='tester', QA_TEST_EVENTS=self.events,
                   # A caller's SHA cannot replace resolve_ref's Git result.
                   ALLRICE_RELEASE_SHA='c' * 40, QA_TEST_IDENTITY_FAIL='1' if identity_fail else '')
        result = subprocess.run(['/bin/bash', self.script, 'met-218-test', '--owner', 'test-line', '--card', 'MET-218', '--ref', SOURCE_SHA],
                                env=env, capture_output=True, text=True, timeout=20)
        with open(self.events) as f:
            return result, [json.loads(line) for line in f]

    def test_identity_is_prepared_after_build_and_native_artifact_before_database_or_start(self):
        result, events = self.up()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        build = next(i for i, e in enumerate(events) if e['command'] == 'pnpm' and 'build' in e['args'])
        native = next(i for i, e in enumerate(events) if e['command'] == 'node' and 'prepare-native-artifact.mjs' in e['args'][0])
        identity = next(i for i, e in enumerate(events) if e['command'] == 'node' and 'prepare-identity.mjs' in e['args'][0])
        database = next(i for i, e in enumerate(events) if e['command'] == 'createdb')
        start = next(i for i, e in enumerate(events) if e['command'] == 'launchctl' and e['args'][0] == 'bootstrap')
        self.assertLess(build, native)
        self.assertLess(native, identity)
        self.assertLess(identity, database)
        self.assertLess(database, start)
        self.assertEqual(events[identity]['cwd'], self.release)
        self.assertEqual(events[identity]['args'], [
            'scripts/dev-release/prepare-identity.mjs', '--root=' + self.release,
            '--release-sha=' + SOURCE_SHA,
        ])
        for role in ('web', 'worker'):
            with open(os.path.join(os.path.dirname(self.release), role + '.plist'), 'rb') as f:
                env = plistlib.load(f)['EnvironmentVariables']
            self.assertEqual(env['ALLRICE_DEV_MAINTENANCE_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_CLOUD_RUNNER_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_CLOUD_MCP_ENABLED'], '0')
            self.assertEqual(env['ALLRICE_RELEASE_SHA'], SOURCE_SHA)
            self.assertEqual(env['ALLRICE_DSH_NATIVE_ARTIFACT_ID'], ARTIFACT_ID)
            self.assertEqual(env['UNRELATED_SETTING'], 'keep')
        with open(os.path.join(os.path.dirname(self.release), 'instance.json')) as f:
            data = json.load(f)
            self.assertEqual(data['setup'], 'ready')
            self.assertEqual(data['owner'], 'test-line')
            self.assertEqual(data['card'], 'MET-218')
            self.assertIn('expiresAt', data)
        bootstrap = next(e for e in events if e['command'] == 'node' and e['args'][0].endswith('/qa-bootstrap.mjs'))
        self.assertEqual(bootstrap['args'][bootstrap['args'].index('--rice') + 1], self.release + '/scripts/m1/rice-standard.json')

    def test_identity_failure_stops_before_database_creation_or_services(self):
        result, events = self.up(identity_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('build identity preparation failed', result.stderr)
        self.assertEqual(events[-1]['command'], 'node')
        self.assertEqual(events[-1]['args'][0], 'scripts/dev-release/prepare-identity.mjs')
        self.assertFalse(any(e['command'] in ('psql', 'createdb', 'launchctl', 'curl') for e in events))
        self.assertFalse(any(e['command'] == 'pnpm' and 'db:prepare' in e['args'] for e in events))
        with open(os.path.join(os.path.dirname(self.release), 'instance.json')) as f:
            self.assertEqual(json.load(f)['setup'], 'building')
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.release), 'worker.plist')))


    def cli(self, *args, **extra):
        return subprocess.run(['/bin/bash', self.dispatch_script, *args],
                              env=dict(os.environ, HOME=self.home, USER='tester', QA_TEST_EVENTS=self.events, **extra),
                              capture_output=True, text=True, timeout=20)

    def seed(self, task, expired=True):
        directory = Path(self.home, 'allrice-qa', task)
        (directory / 'logs').mkdir(parents=True)
        now = time.time()
        from datetime import datetime, timezone
        stamp = lambda value: datetime.fromtimestamp(value, timezone.utc).isoformat()
        data = {'task': task, 'webPort': 3298, 'workerPort': 3299, 'sha': SOURCE_SHA,
                'ref': SOURCE_SHA, 'database': 'allrice_qa_' + task.replace('-', '_'),
                'owner': 'owner-' + task, 'card': 'MET-220', 'createdAt': stamp(now - 86400),
                'expiresAt': stamp(now - 60 if expired else now + 600)}
        (directory / 'instance.json').write_text(json.dumps(data))
        (directory / 'creds.json').write_text('SECRET-CREDS')
        (directory / '.env').write_text('SECRET-ENV')
        (directory / 'logs/build.log').write_text('safe build output')
        (directory / 'logs/creds.json').write_text('SECRET-CREDS')
        (directory / 'logs/secret.log').symlink_to(directory / 'creds.json')
        return directory

    def test_full_capacity_reclaims_expired_stopped_only_and_archives_without_creds(self):
        old = self.seed('expired-stopped')
        live = self.seed('expired-live')
        fresh = self.seed('fresh', expired=False)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', QA_TEST_LIVE='expired-live')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(live.exists())
        self.assertTrue(fresh.exists())
        archives = list(Path(self.home, 'allrice-dev/qa/codex/qa-reclaimed').iterdir())
        self.assertEqual(len(archives), 1)
        files = sorted(str(p.relative_to(archives[0])) for p in archives[0].rglob('*') if p.is_file())
        self.assertEqual(files, ['instance.json', 'logs/build.log'])
        self.assertNotIn('SECRET', ''.join(p.read_text() for p in archives[0].rglob('*') if p.is_file()))
        self.assertFalse(Path(self.home, 'allrice-qa/.task-met-218-test.lock').exists())

    def test_full_capacity_keeps_running_and_prints_occupants(self):
        for task in ['one', 'two', 'three']:
            self.seed(task)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', QA_TEST_LIVE='one,two,three')
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertIn('owner=owner-one', result.stderr)
        self.assertIn('process=running lease=expired', result.stderr)
        self.assertEqual(len(list(Path(self.home, 'allrice-qa').glob('*/instance.json'))), 3)
        self.assertFalse(Path(self.home, 'allrice-dev/qa/codex/qa-reclaimed').exists())

    def test_renew_preserves_creation_and_caps_ttl(self):
        directory = self.seed('renew-me')
        before = json.loads((directory / 'instance.json').read_text())
        result = self.cli('renew', 'renew-me', '--ttl', '24h')
        self.assertEqual(result.returncode, 0, result.stderr)
        after = json.loads((directory / 'instance.json').read_text())
        self.assertEqual(before['createdAt'], after['createdAt'])
        self.assertNotEqual(before['expiresAt'], after['expiresAt'])
        refused = self.cli('renew', 'renew-me', '--ttl', '25h')
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(after, json.loads((directory / 'instance.json').read_text()))

    def test_wait_does_not_hold_allocator_and_continues_when_owner_releases(self):
        for task in ['one', 'two', 'three']:
            self.seed(task, expired=False)
        result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218', '--wait',
                          LINEAR_API_KEY='test-only', QA_TEST_RELEASE='one')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(Path(self.home, 'allrice-qa/met-218-test/instance.json').exists())
        self.assertFalse(Path(self.home, 'allrice-qa/one').exists())

    def test_task_lock_prevents_reclaim_during_other_operation(self):
        import fcntl
        for task in ['one', 'two', 'three']:
            self.seed(task, expired=task == 'one')
        with Path(self.home, 'allrice-qa/.task-one.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = self.cli('up', 'met-218-test', '--owner', 'tester', '--card', 'MET-218')
        self.assertEqual(result.returncode, 75, result.stdout + result.stderr)
        self.assertTrue(Path(self.home, 'allrice-qa/one/instance.json').exists())

    def test_missing_owner_card_or_ref_template_refuses_before_build(self):
        for args in [[], ['--owner', 'test'], ['--card', 'MET-220']]:
            result = self.cli('up', 'met-218-test', *args)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(Path(self.events).exists())
        result = self.cli('up', 'met-218-test', '--owner', 'test', '--card', 'MET-220', QA_TEST_MISSING_RICE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ref has no Rice template', result.stderr)
        events = [json.loads(line) for line in Path(self.events).read_text().splitlines()]
        self.assertFalse(any(e['command'] in ['pnpm', 'createdb', 'node'] for e in events))


if __name__ == '__main__':
    unittest.main()
