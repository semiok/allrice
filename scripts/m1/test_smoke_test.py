# Unit tests for the database side of the smoke test's "continue" check (MET-221 PR2b-0):
# the Python embedded in scripts/m1/smoke-test that picks the earlier session and verifies
# the follow-up, run against a stub psql.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, 'smoke-test')) as f:
    SMOKE_PY = f.read().split("SMOKE_PY=$(cat <<'PY'\n", 1)[1].split('\nPY\n)', 1)[0]
A, B, C = ('aaaaaaaa-0000-4000-8000-00000000000%d' % i for i in (1, 2, 3))
SEAL1, SEAL2 = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


def origin(seal):
    return json.dumps({'schemaVersion': 2, 'artifactId': seal})


def digest(text):
    return 'sha256:' + hashlib.sha256(text.encode()).hexdigest()


class SmokeContinue(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='smoke-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        stub = os.path.join(self.tmp, 'bin/psql')
        os.makedirs(os.path.dirname(stub))
        with open(stub, 'w') as f:  # answers by table: sessions and runs come from files
            f.write('#!/bin/sh\n[ -z "$PSQL_FAIL" ] || { echo "connection refused" >&2; exit 2; }\n'
                    'for a; do q=$a; done\ncase "$q" in *allrice_chat_sessions*) cat "$SESSIONS" ;; '
                    '*allrice_employee_runs*) cat "$RUNS" ;; esac\n')
        os.chmod(stub, 0o755)
        self.smoke = os.path.join(self.tmp, 'smoke')
        self.creds = os.path.join(self.tmp, 'creds.json')
        with open(self.creds, 'w') as f:
            json.dump({'username': 'smoke'}, f)

    def run_py(self, args, sessions=(), runs=(), **env):
        files = {}
        for name, rows in (('SESSIONS', sessions), ('RUNS', runs)):
            files[name] = os.path.join(self.tmp, name.lower())
            with open(files[name], 'w') as f:
                f.write(''.join('\t'.join(r) + '\n' for r in rows))
        env = dict(os.environ, PATH=os.path.join(self.tmp, 'bin') + ':/usr/bin:/bin', SMOKE_DATABASE_URL='postgres://stub', **files, **env)
        return subprocess.run([sys.executable, '-c', SMOKE_PY] + list(args), env=env, capture_output=True, text=True, timeout=60)

    def result(self, name, results, at, account='smoke', **extra):
        d = os.path.join(self.smoke, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'result.json'), 'w') as f:
            json.dump(dict(account=account, at=at, results=results, **extra), f)
        return d

    def verify(self, results, seal, seed='', started=None, **kw):
        out = self.result('now', results, '2026-10-27T00:00:00Z')
        p = self.run_py(['verify', out, seal, seed, str(started or time.time() - 60), '1'], **kw)
        with open(os.path.join(out, 'result.json')) as f:
            return p, json.load(f)

    def seed(self, sid=A, text=origin(SEAL1), session_seal=SEAL1):
        entry = {'check': 'chat', 'pass': True, 'sessionId': sid, 'originDigest': digest(text), 'sessionSeal': session_seal}
        return os.path.join(self.result('before', [entry], '2026-10-26T00:00:00Z', nativeArtifactId=session_seal), 'result.json')

    def follow_up(self, sid=A):
        return [{'check': 'continue', 'pass': True, 'sessionId': sid, 'continued': True, 'prompt': "冒烟测试 x：it's a follow-up", 'detail': ''}]

    def test_first_run_records_the_new_sessions(self):
        p, r = self.verify([{'check': 'chat', 'pass': True, 'sessionId': A},
                            {'check': 'continue', 'pass': True, 'skipped': True, 'sessionId': B}], SEAL1,
                           sessions=[(A, origin(SEAL1), SEAL1, 'f'), (B, origin(SEAL1), SEAL1, 'f')])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual([(x['originDigest'], x['sessionSeal']) for x in r['results']], [(digest(origin(SEAL1)), SEAL1)] * 2)

    def test_first_run_fails_when_the_new_session_cannot_be_recorded(self):
        p, r = self.verify([{'check': 'continue', 'pass': True, 'skipped': True, 'sessionId': B}], SEAL1)
        self.assertEqual(p.returncode, 1)
        self.assertIn('could not record the new session origin', r['results'][0]['detail'])

    def test_follow_up_on_the_same_artifact(self):
        p, r = self.verify(self.follow_up(), SEAL1, self.seed(), sessions=[(A, origin(SEAL1), SEAL1, 'f')], runs=[('succeeded', SEAL1)])
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertFalse(r['results'][0]['database']['acrossArtifacts'])

    def test_follow_up_across_artifacts(self):
        # Created under SEAL1 and continued under SEAL2; the run keeps the origin's artifact (D3).
        p, r = self.verify(self.follow_up(), SEAL2, self.seed(), sessions=[(A, origin(SEAL1), SEAL1, 'f')], runs=[('succeeded', SEAL1)])
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertTrue(r['results'][0]['database']['acrossArtifacts'])
        self.assertEqual(r['results'][0]['sessionSeal'], SEAL1)

    def test_back_on_the_creation_artifact_is_not_across(self):
        # Created under SEAL1, continued under SEAL2 (that run's report names SEAL2), now SEAL1 again.
        seed = self.seed(session_seal=SEAL1)
        with open(seed) as f:
            r = json.load(f)
        r['nativeArtifactId'] = SEAL2
        with open(seed, 'w') as f:
            json.dump(r, f)
        p, r = self.verify(self.follow_up(), SEAL1, seed, sessions=[(A, origin(SEAL1), SEAL1, 'f')], runs=[('succeeded', SEAL1)])
        self.assertEqual(p.returncode, 0, p.stdout)
        self.assertFalse(r['results'][0]['database']['acrossArtifacts'])

    def test_failures_are_reported(self):
        cases = [
            ('origin names the current seal', SEAL2, origin(SEAL2), [('succeeded', SEAL2)], 'yet its origin names the current one'),
            ('origin bytes changed', SEAL1, origin(SEAL1) + ' ', [('succeeded', SEAL1)], 'native_root_origin changed'),
            ('run failed', SEAL1, origin(SEAL1), [('failed', SEAL1)], 'the follow-up run is failed'),
            ('no run', SEAL1, origin(SEAL1), [], 'found 0'),
        ]
        for label, seal, text, runs, expected in cases:
            with self.subTest(label):
                p, r = self.verify(self.follow_up(), seal, self.seed(), sessions=[(A, text, json.loads(text)['artifactId'], 'f')], runs=runs)
                self.assertEqual(p.returncode, 1)
                self.assertFalse(r['results'][0]['pass'])
                self.assertIn(expected, r['results'][0]['detail'])

    def test_unreadable_database_is_one_problem(self):
        p, r = self.verify(self.follow_up(), SEAL1, self.seed(), PSQL_FAIL='1')
        self.assertEqual(p.returncode, 1)
        self.assertIn('connection refused', r['results'][0]['detail'])
        self.assertNotIn('changed', r['results'][0]['detail'])

    def test_stale_result_keeps_the_node_exit_code(self):
        out = self.result('old', [{'check': 'chat', 'pass': True}], '2026-10-26T00:00:00Z')
        p = self.run_py(['verify', out, SEAL1, '', str(time.time() + 60), '2'])
        self.assertEqual(p.returncode, 2)
        self.assertIn('wrote no result.json', p.stderr)

    def test_pick_prefers_the_newest_usable_chat_session(self):
        entry = lambda check, sid: {'check': check, 'pass': True, 'sessionId': sid, 'originDigest': 'sha256:x'}
        self.result('1-old', [entry('chat', C)], '2026-10-25T00:00:00Z')
        self.result('2-new', [entry('continue', B), entry('chat', A)], '2026-10-26T00:00:00Z')
        self.result('3-other', [entry('chat', B)], '2026-10-27T00:00:00Z', account='someone-else')
        out = os.path.join(self.smoke, '4-now')
        live = [(s, '{}', SEAL1, 'f') for s in (A, B, C)]
        p = self.run_py(['pick', self.smoke, out, self.creds], sessions=live)
        self.assertEqual(p.stdout.split(), [A, os.path.join(self.smoke, '2-new', 'result.json')])
        # The newest run's sessions were archived: fall back to the older run's.
        p = self.run_py(['pick', self.smoke, out, self.creds], sessions=[(A, '{}', SEAL1, 't'), (C, '{}', SEAL1, 'f')])
        self.assertEqual(p.stdout.split()[0], C)
        self.assertIn('gone or archived', p.stderr)


if __name__ == '__main__':
    unittest.main()
