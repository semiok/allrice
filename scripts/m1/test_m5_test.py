# Unit tests for scripts/m1/m5-test and m5-run (MET-216): where a run goes (M5, or M1 when M5
# is offline or not set up), what reaches the test command, the slot limit, a lost
# connection, and the Codex pass. A fake `ssh` runs the "remote" side in a second home
# directory; pnpm and codex are stubs that record what they were given.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import fcntl
import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
M5_TEST = os.path.join(HERE, 'm5-test')
M5_RUN = os.path.join(HERE, 'm5-run')
GIT_ENV = dict(GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.com', GIT_COMMITTER_NAME='t',
               GIT_COMMITTER_EMAIL='t@example.com', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')

SSH = r'''#!/bin/bash
# fake `ssh`: runs the command in $M5_FAKE_HOME, as a login on M5 would
while [ $# -gt 0 ]; do case "$1" in -o|-p|-l|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift # the host
[ ! -e "$M5_FAKE_HOME/offline" ] || { echo "ssh: connect to host m5: Operation timed out" >&2; exit 255; }
cd "$M5_FAKE_HOME" || exit 255
case "$*" in
  *M5T_ACTION=test*) [ ! -e drop ] || { HOME=$PWD /bin/sh -c "$*" | grep -v '^m5-test: done on '; exit 255; } ;;
esac
HOME=$PWD exec /bin/sh -c "$*"
'''
PNPM = r'''#!/bin/sh
# stub pnpm: records the call and the environment it saw
echo "$*|$ALLRICE_TEST_DATABASE_URL|${ALLRICE_RUN_DB_INTEGRATION:-}|${ALLRICE_RUN_BROWSER_INTEGRATION:-}|${ALLRICE_X:-}|${LEAK_ME:-}|$PWD" >>"$HOME/pnpm.calls"
case "$1" in
  install) mkdir -p node_modules; touch node_modules/kept; exit "$(cat "$HOME/install.rc" 2>/dev/null || echo 0)" ;;
  exec) echo "vitest says hello"; exit "$(cat "$HOME/vitest.rc" 2>/dev/null || echo 0)" ;;
esac
'''
CODEX = r'''#!/bin/sh
# stub codex: records its arguments and prompt, writes a result, changes the worktree
echo "$*" >"$HOME/codex.args"; cat >"$HOME/codex.prompt"
out=""; prev=""; for a; do [ "$prev" != -o ] || out=$a; prev=$a; done
echo "test report" >"$out"; echo changed >>README.md; echo new >new.test.ts
'''


def write(path, text, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, mode)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        return default


class M5Test(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix='m5-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.m1 = os.path.join(self.tmp, 'm1')  # HOME on M1
        self.m5 = os.path.join(self.tmp, 'm5')  # HOME on M5
        self.repo = os.path.join(self.m1, 'allrice-repo')
        self.git('init', '-q', '-b', 'main', self.repo, cwd=self.tmp)
        write(os.path.join(self.repo, 'README.md'), 'hi\n')
        write(os.path.join(self.repo, '.gitignore'), 'node_modules\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'first')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        for home in (self.m1, self.m5):
            write(os.path.join(home, '.local/opt/node-22.23.2/bin/pnpm'), PNPM, 0o755)
        write(os.path.join(self.m1, '.local/bin/codex'), CODEX, 0o755)
        self.codex = os.path.join(self.m5, 'codex')
        write(self.codex, CODEX, 0o755)
        base = os.path.join(self.m5, 'allrice-test')
        line = subprocess.run(['/bin/bash', M5_RUN], env=dict(os.environ, M5T_ACTION='setup-line', M5T_TARGET='m5'),
                              capture_output=True, text=True, check=True).stdout
        write(os.path.join(base, 'SETUP'), line)
        write(os.path.join(base, 'dist/postgresql-17.11-pgvector-0.8.7/bin/pg_ctl'), '#!/bin/sh\nexit 0\n', 0o755)
        self.git('init', '-q', '--bare', os.path.join(base, 'repo.git'), cwd=self.tmp)
        self.ssh = os.path.join(self.tmp, 'bin/ssh')
        write(self.ssh, SSH, 0o755)

    def git(self, *args, cwd=None):
        return subprocess.run(['git'] + list(args), cwd=cwd or self.repo, env=dict(os.environ, **GIT_ENV),
                              capture_output=True, text=True, check=True).stdout

    def run_m5(self, *args, stdin=None, **env):
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, M5T_CODEX=self.codex,
                   LEAK_ME='caller-secret', **GIT_ENV, **env)
        return subprocess.run([M5_TEST] + list(args), cwd=self.repo, env=env, input=stdin or '',
                              capture_output=True, text=True, timeout=120)

    def calls(self, home):
        return [line.split('|') for line in read(os.path.join(home, 'pnpm.calls'), '').splitlines()]

    def test_runs_on_m5_with_its_database_and_a_worker_cap(self):
        p = self.run_m5('--db', '-e', 'ALLRICE_X=on', '--', '--maxWorkers=50', 'a.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('m5-test: done on M5 (%s, slot 1, install' % self.sha[:8], p.stdout)
        calls = self.calls(self.m5)
        self.assertEqual([c[0] for c in calls], ['install --frozen-lockfile --prefer-offline --store-dir %s/allrice-test/pnpm-store' % self.m5,
                                                 '--filter @allrice/contracts build', 'exec vitest run a.test.ts --maxWorkers=6'])
        self.assertEqual(calls[-1][1:6], ['postgres://allrice:allrice@127.0.0.1:54329/allrice', '1', '', 'on', ''])  # LEAK_ME stays home
        self.assertEqual(calls[-1][6], os.path.join(self.m5, 'allrice-test/slots/slot-1'))
        self.assertEqual(self.calls(self.m1), [])
        self.assertEqual(self.git('rev-parse', 'refs/m5-test/' + self.sha, cwd=os.path.join(self.m5, 'allrice-test/repo.git')).strip(), self.sha)
        log = p.stdout.strip().splitlines()[-1].split('m5-test: log ')[1]
        self.assertIn('vitest says hello', read(log))

    def test_test_exit_code_comes_back(self):
        write(os.path.join(self.m5, 'vitest.rc'), '1\n')
        p = self.run_m5('--', '--maxWorkers', '3', 'b.test.ts')
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertEqual(self.calls(self.m5)[-1][0], 'exec vitest run b.test.ts --maxWorkers=3')
        self.assertRegex(p.stdout, r'done on M5 \(.*vitest \d+s\), exit 1')

    def test_failed_install_stops_the_run(self):
        write(os.path.join(self.m5, 'install.rc'), '7\n')
        p = self.run_m5('--', 'c.test.ts')
        self.assertEqual(p.returncode, 7)
        self.assertIn('install failed), exit 7', p.stdout)
        self.assertEqual(len(self.calls(self.m5)), 1)

    def test_offline_m5_falls_back_to_m1_with_two_workers(self):
        write(os.path.join(self.m5, 'offline'), '')
        p = self.run_m5('--browser', '--no-build', '--', '--max-workers=4', 'd.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5 不在线', p.stdout)
        self.assertIn('改在 M1 跑（--maxWorkers=2）', p.stdout)
        calls = self.calls(self.m1)
        self.assertEqual([c[0] for c in calls], ['install --frozen-lockfile --prefer-offline', 'exec vitest run d.test.ts --maxWorkers=2'])
        self.assertEqual(calls[-1][1:4], ['postgres://a123@127.0.0.1:5432/allrice_b2', '', '1'])
        self.assertEqual(calls[-1][6], os.path.join(self.m1, 'allrice-worktrees/.m5-test-m1/slots/slot-1'))
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=calls[-1][6]).strip(), self.sha)

    def test_m5_not_set_up_falls_back_or_refuses(self):
        write(os.path.join(self.m5, 'allrice-test/SETUP'), 'node=old\n')
        p = self.run_m5('--', 'e.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('没配好', p.stdout)
        self.assertEqual(len(self.calls(self.m1)), 3)
        p = self.run_m5('--on', 'm5', '--', 'e.test.ts')
        self.assertEqual(p.returncode, 4)
        self.assertEqual(len(self.calls(self.m1)), 3)

    def test_busy_slots_exit_3(self):
        lock = os.path.join(self.m5, 'allrice-test/locks/slot-1.lock')
        write(lock, '')
        write(lock.replace('.lock', '.owner'), 'run-x deadbeef by met-1 since 10:00 (test)\n')
        with open(lock, 'a') as f:
            fcntl.flock(f, fcntl.LOCK_EX)  # a different open file: the run cannot take it
            p = self.run_m5('--wait', '0', '--', 'f.test.ts', M5_TEST_SLOTS='1')
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertIn('every M5 test slot is busy', p.stdout)
        self.assertIn('slot 1: run-x deadbeef by met-1', p.stdout)
        self.assertEqual(self.calls(self.m5), [])

    def test_lost_connection_is_reported(self):
        write(os.path.join(self.m5, 'drop'), '')
        p = self.run_m5('--', 'g.test.ts')
        self.assertEqual(p.returncode, 255)
        self.assertIn('the connection to M5 broke during the run', p.stderr)

    def test_next_run_reuses_the_slot_clean(self):
        self.assertEqual(self.run_m5('--', 'h.test.ts').returncode, 0)
        wt = os.path.join(self.m5, 'allrice-test/slots/slot-1')
        write(os.path.join(wt, 'leftover.txt'), 'x')
        write(os.path.join(wt, 'README.md'), 'edited\n')
        write(os.path.join(self.repo, 'README.md'), 'second\n')
        self.git('commit', '-qam', 'second')
        p = self.run_m5('--', 'h.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertFalse(os.path.exists(os.path.join(wt, 'leftover.txt')))
        self.assertEqual(read(os.path.join(wt, 'README.md')), 'second\n')
        self.assertTrue(os.path.exists(os.path.join(wt, 'node_modules/kept')))

    def test_codex_on_m5_returns_result_and_patch(self):
        out = os.path.join(self.tmp, 'out/report.md')
        p = self.run_m5('codex', '--db', '-o', out, stdin='写测试并运行\n')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(read(out), 'test report\n')
        patch = read(os.path.join(self.tmp, 'out/report.patch'))
        self.assertIn('+changed', patch)
        self.assertIn('new.test.ts', patch)
        self.assertEqual(read(os.path.join(self.m5, 'codex.prompt')), '写测试并运行\n')
        args = read(os.path.join(self.m5, 'codex.args'))
        for part in ('exec -C %s/allrice-test/slots/slot-1 ' % self.m5, '-m gpt-6-astra -c model_reasoning_effort=max',
                     '-c allow_login_shell=false', '-s workspace-write -c sandbox_workspace_write.network_access=true'):
            self.assertIn(part, args)
        self.assertEqual(len(self.calls(self.m5)), 2)  # install and build, before Codex
        self.assertEqual(self.run_m5('--no-build', '--', 'x.test.ts').returncode, 0)  # the next run gets a clean slot
        wt = os.path.join(self.m5, 'allrice-test/slots/slot-1')
        self.assertFalse(os.path.exists(os.path.join(wt, 'new.test.ts')))
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=no', cwd=wt), '')

    def test_codex_full_access_on_request(self):
        p = self.run_m5('codex', '--full-access', '--no-build', '-o', os.path.join(self.tmp, 'f.md'), '--', 'browser tests')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        args = read(os.path.join(self.m5, 'codex.args'))
        self.assertIn('-s danger-full-access', args)
        self.assertNotIn('workspace-write', args)
        self.assertEqual(self.run_m5('--full-access', '--', 'x').returncode, 2)  # not for plain tests

    def test_codex_on_m1_has_full_access(self):
        write(os.path.join(self.m5, 'offline'), '')
        out = os.path.join(self.tmp, 'm1.md')
        p = self.run_m5('codex', '--no-build', '-o', out, '--', 'test it')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('-s danger-full-access', read(os.path.join(self.m1, 'codex.args')))
        self.assertEqual(read(out), 'test report\n')

    def test_rejects_bad_arguments(self):
        for args in (['-e', 'ALLRICE_API_KEY=x', '--', 'a'], ['-e', 'PATH=/x', '--', 'a'], ['nope', '--', 'a'],
                     ['--wait', 'soon', '--', 'a'], ['codex', '--', 'no -o']):
            with self.subTest(args=args):
                p = self.run_m5(*args)
                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertEqual(self.calls(self.m5) + self.calls(self.m1), [])

    def test_uncommitted_changes_are_named(self):
        write(os.path.join(self.repo, 'README.md'), 'dirty\n')
        p = self.run_m5('--', 'i.test.ts')
        self.assertIn('uncommitted changes in %s are not part of this run' % self.repo, p.stdout)
        self.assertEqual(read(os.path.join(self.m5, 'allrice-test/slots/slot-1/README.md')), 'hi\n')


if __name__ == '__main__':
    unittest.main()
