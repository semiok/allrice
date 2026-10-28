# Exercise the production cmd_up in a private HOME. Only external commands and
# port availability are stubbed; no PostgreSQL, launchd, network or live QA state.
# CI collects this with python3 -m unittest discover -s scripts/m1 -p 'test_*.py'.
import json
import os
import plistlib
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE_SHA = 'a' * 40
ARTIFACT_ID = 'sha256:' + 'b' * 64

COMMAND_STUB = '''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
command, args = Path(sys.argv[0]).name, sys.argv[1:]
with open(os.environ['QA_TEST_EVENTS'], 'a') as f:
    f.write(json.dumps({'command': command, 'args': args, 'cwd': os.getcwd()}) + '\\n')
if command == 'git':
    if 'rev-parse' in args:
        print('a' * 40)
    elif 'worktree' in args:
        Path(args[-2]).mkdir(parents=True)
elif command == 'node':
    if args[0].endswith('/prepare-native-artifact.mjs'):
        print(json.dumps({'artifactId': 'sha256:' + 'b' * 64}))
    elif args[0].endswith('/prepare-identity.mjs') and os.environ.get('QA_TEST_IDENTITY_FAIL'):
        sys.exit(42)
elif command not in ('pnpm', 'psql', 'createdb', 'launchctl', 'curl'):
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
        for name in ('git', 'pnpm', 'node', 'psql', 'createdb', 'launchctl', 'curl'):
            path = os.path.join(node_bin, name)
            with open(path, 'w') as f:
                f.write(COMMAND_STUB)
            os.chmod(path, 0o755)
        # Keep cmd_up unchanged, replacing only the host port probe. Its actual
        # allocation lock, file writes, plist generation and error exits run.
        with open(os.path.join(HERE, 'qa-instance')) as f:
            definitions, marker, _ = f.read().partition('\ncase "${1:-}" in')
        self.assertTrue(marker, 'qa-instance command dispatch marker changed')
        self.script = os.path.join(self.tmp, 'qa-instance')
        with open(self.script, 'w') as f:
            f.write(definitions + '\nport_busy() { return 1; }\ncmd_up "$@"\n')
        shutil.copyfile(os.path.join(HERE, 'lib.sh'), os.path.join(self.tmp, 'lib.sh'))
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
        result = subprocess.run(['/bin/bash', self.script, 'met-218-test', '--ref', SOURCE_SHA],
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
            self.assertEqual(json.load(f)['setup'], 'ready')

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


if __name__ == '__main__':
    unittest.main()
