# Unit tests for scripts/m1/m5-test and m5-run (MET-216): where a run goes (M5, or M1 when M5
# is offline, not set up, short of memory, full or drops out mid-run), what reaches the test
# command, the worker budget, leftovers of interrupted runs, and the Codex pass. A fake `ssh`
# runs the "remote" side in a second home directory; pnpm, psql, codex, sysctl and vm_stat are
# stubs that record what they were given.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
M5_TEST = os.path.join(HERE, 'm5-test')
M5_RUN = os.path.join(HERE, 'm5-run')
GIT_ENV = dict(GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@example.com', GIT_COMMITTER_NAME='t',
               GIT_COMMITTER_EMAIL='t@example.com', GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1')
PG = 'allrice-test/dist/postgresql-17.11-pgvector-0.8.7/bin'

SSH = r'''#!/bin/bash
# fake `ssh`: runs the command in $M5_FAKE_HOME, as a login on M5 would
while [ $# -gt 0 ]; do case "$1" in -o|-p|-l|-i) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift # the host
[ ! -e "$M5_FAKE_HOME/offline" ] || { echo "ssh: connect to host m5: Operation timed out" >&2; exit 255; }
cd "$M5_FAKE_HOME" || exit 255
case "$*" in
  *M5T_ACTION=test*|*M5T_ACTION=codex*)
    [ ! -e hang ] || { echo "starting"; sleep 30; exit 0; }
    [ ! -e drop ] || { HOME=$PWD /bin/sh -c "$*" | grep -v '^m5-test: done on '; exit 255; }
    [ ! -e late-drop ] || { HOME=$PWD /bin/sh -c "$*"; exit 255; }
    [ ! -e slept ] || { HOME=$PWD /bin/sh -c "$*"; echo "m5-test: M5 was asleep 40s during this run; it is no verdict"; exit 76; } ;;
esac
HOME=$PWD exec /bin/sh -c "$*"
'''
PNPM = r'''#!/bin/sh
# stub pnpm: records the call and the environment it saw
echo "$*|$ALLRICE_TEST_DATABASE_URL|${ALLRICE_RUN_DB_INTEGRATION:-}|${ALLRICE_RUN_BROWSER_INTEGRATION:-}|${ALLRICE_RUN_X:-}|${LEAK_ME:-}|$PWD|${M5T_VITEST_CAP:-}|$PGPORT|$HOME|${ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE:-}" >>"$HOME/pnpm.calls"
case "$1" in
  install) mkdir -p node_modules/.bin; touch node_modules/kept; cp "$(dirname "$0")/vitest" node_modules/.bin/vitest; exit "$(cat "$HOME/install.rc" 2>/dev/null || echo 0)" ;;
  exec) [ ! -e "$HOME/detach" ] || { # a detached process, orphaned at once, that starts a child of its own later
      ( /usr/bin/python3 -c 'import os,subprocess,sys,time
os.setsid(); open(sys.argv[1],"w").write(str(os.getpid())); time.sleep(2)
open(sys.argv[2],"w").write(str(subprocess.Popen(["sleep","120"]).pid)); time.sleep(120)' "$HOME/detached.pid" "$HOME/detached-child.pid" & sleep 1 )
      [ ! -e "$HOME/postgres-too" ] || { postgres-standin 120 </dev/null >/dev/null 2>&1 & }  # as ensure_pg starts it
      sleep 3; }
    [ ! -e "$HOME/hang" ] || { trap '' TERM; echo $$ >"$HOME/hang.pid"; sleep "$(cat "$HOME/hang.seconds" 2>/dev/null || echo 30)"; }; echo "vitest says hello"; exit "$(cat "$HOME/vitest.rc" 2>/dev/null || echo 0)" ;;
esac
'''
VITEST = r'''#!/bin/sh
# stub vitest, as node_modules/.bin/vitest: recorded like pnpm (same file), "exec vitest …"
exec pnpm exec vitest "$@"
'''
CODEX = r'''#!/bin/sh
# stub codex: records its arguments and prompt, writes a result, changes the worktree
[ "$1" != login ] || exit 0
echo "$*" >"$HOME/codex.args"; cat >"$HOME/codex.prompt"; echo "$M5T_VITEST_CAP" >"$HOME/codex.workers"
out=""; prev=""; for a; do [ "$prev" != -o ] || out=$a; prev=$a; done
echo "test report" >"$out"; echo changed >>README.md; echo new >new.test.ts
'''
PSQL = r'''#!/bin/sh
# stub psql: leftover schemas come from $HOME/leftovers; statements on stdin are recorded
for a; do q=$a; done
case "$q" in
  *pg_namespace*) [ ! -f "$HOME/leftovers" ] || sed 's/.*/drop schema if exists "&" cascade;/' "$HOME/leftovers" ;;
  *pg_database*) ;;
  *) cat >>"$HOME/psql.stdin" ;;
esac
'''
SYSCTL = r'''#!/bin/sh
case "$2" in
  kern.memorystatus_vm_pressure_level) cat "$M5_FAKE_HOME/pressure" 2>/dev/null || echo 1 ;;
  *) echo 1 ;;
esac
'''
VM_STAT = r'''#!/bin/sh
echo "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
echo "Pages free:                               $(cat "$M5_FAKE_HOME/free_pages" 2>/dev/null || echo 4000000)."
echo "Pages active:                              3579860."
echo "Pages inactive:                                  0."
'''
HOLD = 'import fcntl,sys,time\nf=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX); print("held",flush=True); time.sleep(120)'


def signal_all(pids, sig):  # short-lived helpers of a waiting run may be gone already
    for p in pids:
        try:
            os.kill(p, sig)
        except ProcessLookupError:
            pass


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
            write(os.path.join(home, '.local/opt/node-22.23.2/bin/vitest'), VITEST, 0o755)
        write(os.path.join(self.m1, '.local/bin/codex'), CODEX, 0o755)
        self.codex = os.path.join(self.m5, 'codex')
        write(self.codex, CODEX, 0o755)
        self.base = os.path.join(self.m5, 'allrice-test')
        line = subprocess.run(['/bin/bash', M5_RUN], env=dict(os.environ, M5T_ACTION='setup-line', M5T_TARGET='m5'),
                              capture_output=True, text=True, check=True).stdout
        write(os.path.join(self.base, 'SETUP'), line)
        write(os.path.join(self.m5, PG, 'pg_ctl'), '#!/bin/sh\n[ ! -e "$HOME/pg-down" ]\n', 0o755)
        write(os.path.join(self.m5, PG, 'psql'), PSQL, 0o755)
        self.git('init', '-q', '--bare', os.path.join(self.base, 'repo.git'), cwd=self.tmp)
        self.bin = os.path.join(self.tmp, 'bin')
        self.ssh = os.path.join(self.bin, 'ssh')
        write(self.ssh, SSH, 0o755)
        # m5-test sets its own PATH, which starts with the Node directory: stubs go there.
        write(os.path.join(self.m1, '.local/opt/node-22.23.2/bin/sysctl'), SYSCTL, 0o755)
        write(os.path.join(self.m1, '.local/opt/node-22.23.2/bin/vm_stat'), VM_STAT, 0o755)
        self.leases = os.path.join(self.m1, 'allrice-dev/qa/m5-test/leases')
        self.th = os.path.join(self.base, 'home')  # HOME of installs, builds, tests and Codex's commands on M5

    def git(self, *args, cwd=None):
        return subprocess.run(['git'] + list(args), cwd=cwd or self.repo, env=dict(os.environ, **GIT_ENV),
                              capture_output=True, text=True, check=True).stdout

    def run_m5(self, *args, stdin=None, **extra):
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, M5T_CODEX=self.codex,
                   LEAK_ME='caller-secret', **GIT_ENV)
        env.update(extra)
        return subprocess.run([M5_TEST] + list(args), cwd=self.repo, env=env, input=stdin or '',
                              capture_output=True, text=True, timeout=120)

    def calls(self, home):
        return [line.split('|') for line in read(os.path.join(home, 'pnpm.calls'), '').splitlines()]

    def limits(self, **values):
        write(os.path.join(self.base, 'limits'), ''.join('%s=%s\n' % kv for kv in values.items()))

    def hold(self, path, *argv):  # a process holding the flock on <path> until the test ends
        os.makedirs(os.path.dirname(path), exist_ok=True)
        p = subprocess.Popen([sys.executable, '-c', HOLD, path] + list(argv), stdout=subprocess.PIPE, text=True)
        self.addCleanup(p.stdout.close)
        self.addCleanup(p.wait)
        self.addCleanup(p.kill)
        self.assertEqual(p.stdout.readline().strip(), 'held')
        return p

    def test_runs_on_m5_with_its_database_and_worker_budget(self):
        p = self.run_m5('--db', '-e', 'ALLRICE_RUN_X=on', '--', 'a.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('m5-test: done on M5 (%s, slot 1, 8 workers, install' % self.sha[:8], p.stdout)
        self.assertRegex(p.stdout, r'm5-test: finished on M5, exit 0; log ')
        calls = self.calls(self.th)
        self.assertEqual([c[0] for c in calls], ['install --frozen-lockfile --prefer-offline --store-dir %s/pnpm-store' % self.base,
                                                 '--filter @allrice/contracts build', 'exec vitest run a.test.ts --maxWorkers=8'])
        self.assertEqual(calls[-1][1:6], ['postgres://allrice:allrice@127.0.0.1:54329/allrice', '1', '', 'on', ''])  # LEAK_ME stays home
        self.assertEqual(calls[-1][6:], [os.path.join(self.base, 'slots/slot-1'), '8', '54329', self.th,
                                         os.path.join(self.base, 'slots/slot-1/apps/worker/package.json')])
        self.assertEqual(self.calls(self.m1), [])
        refs = self.git('for-each-ref', '--format=%(objectname)', 'refs/m5-test', cwd=os.path.join(self.base, 'repo.git')).split()
        self.assertEqual(refs, [self.sha])
        self.assertEqual(os.listdir(self.leases), [])  # the lease went with the run
        log = p.stdout.strip().splitlines()[-1].split('; log ')[1]
        self.assertIn('vitest says hello', read(log))

    def test_requested_workers_are_capped(self):
        self.assertEqual(self.run_m5('--', '--maxWorkers=50', 'b.test.ts').returncode, 0)
        self.assertEqual(self.run_m5('--', '--maxWorkers', '3', 'b.test.ts').returncode, 0)
        self.limits(WORKERS_MAX=4)
        self.assertEqual(self.run_m5('--', '--max-workers=50%', 'b.test.ts').returncode, 0)
        self.assertEqual([(c[0], c[7]) for c in self.calls(self.th) if c[0].startswith('exec')],
                         [('exec vitest run b.test.ts --maxWorkers=12', '12'), ('exec vitest run b.test.ts --maxWorkers=3', '3'),
                          ('exec vitest run b.test.ts --maxWorkers=4', '4')])

    def test_test_exit_code_comes_back(self):
        write(os.path.join(self.th, 'vitest.rc'), '1\n')
        p = self.run_m5('--', 'b.test.ts')
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertRegex(p.stdout, r'done on M5 \(.*vitest \d+s\), exit 1')
        self.assertEqual(self.calls(self.m1), [])

    def test_killed_tests_rerun_on_m1(self):
        write(os.path.join(self.th, 'vitest.rc'), '137\n')  # SIGKILL on M5: no verdict
        p = self.run_m5('--', 'o.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('m5-test: vitest on M5 ended by signal 9: interrupted, not a result', p.stdout)
        self.assertIn('M5 中断：测试进程被结束（不算测试失败），改在 M1 从头重跑', p.stdout)
        self.assertIn('finished on M1 (M5 dropped out mid-run; the result is from M1), exit 0', p.stdout)

    def test_killed_install_reruns_on_m1(self):
        write(os.path.join(self.th, 'install.rc'), '143\n')
        p = self.run_m5('--', 'o.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('m5-test: install on M5 ended by signal 15: interrupted, not a result', p.stdout)
        self.assertIn('finished on M1 (M5 dropped out mid-run', p.stdout)

    def test_failed_install_stops_the_run(self):
        write(os.path.join(self.th, 'install.rc'), '7\n')
        p = self.run_m5('--', 'c.test.ts')
        self.assertEqual(p.returncode, 7)
        self.assertIn('install failed), exit 7', p.stdout)
        self.assertEqual(len(self.calls(self.th)), 1)

    def test_offline_m5_runs_on_m1_with_two_workers(self):
        write(os.path.join(self.m5, 'offline'), '')
        p = self.run_m5('--browser', '--no-build', '--', '--max-workers=4', 'd.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5 不在线', p.stdout)
        self.assertIn('改在 M1 跑（--maxWorkers=2）', p.stdout)
        self.assertIn('finished on M1, exit 0', p.stdout)
        calls = self.calls(self.m1)
        self.assertEqual([c[0] for c in calls], ['install --frozen-lockfile --prefer-offline', 'exec vitest run d.test.ts --maxWorkers=2'])
        self.assertEqual(calls[-1][1:4], ['postgres://a123@127.0.0.1:5432/allrice_b2', '', '1'])
        self.assertEqual(calls[-1][8:10], ['5432', self.m1])
        self.assertEqual(calls[-1][6], os.path.join(self.m1, 'allrice-worktrees/.m5-test-m1/slots/slot-1'))
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=calls[-1][6]).strip(), self.sha)
        self.assertEqual(self.run_m5('--no-build', '--', 'd.test.ts').returncode, 0)  # M1 keeps its node_modules too
        self.assertTrue(os.path.exists(os.path.join(calls[-1][6], 'node_modules/kept')))

    def test_m5_not_set_up_falls_back_or_refuses(self):
        write(os.path.join(self.base, 'SETUP'), 'node=old\n')
        p = self.run_m5('--', 'e.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('没配好', p.stdout)
        self.assertEqual(len(self.calls(self.m1)), 3)
        p = self.run_m5('--on', 'm5', '--', 'e.test.ts')
        self.assertEqual(p.returncode, 4)
        self.assertEqual(len(self.calls(self.m1)), 3)

    def test_memory_pressure(self):
        write(os.path.join(self.m5, 'pressure'), '2\n')  # warning: half the workers
        p = self.run_m5('--', 'f.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('memory pressure warning (level 2): 4 workers, 8 for all runs', p.stdout)
        self.assertEqual(self.calls(self.th)[-1][0], 'exec vitest run f.test.ts --maxWorkers=4')
        write(os.path.join(self.m5, 'pressure'), '1\n')  # 3G reclaimable at 2G a worker: one
        write(os.path.join(self.m5, 'free_pages'), str(3 * 65536))
        p = self.run_m5('--', 'f.test.ts')
        self.assertIn('3G reclaimable: 1 workers', p.stdout)
        self.assertEqual(self.calls(self.th)[-1][0], 'exec vitest run f.test.ts --maxWorkers=1')
        write(os.path.join(self.m5, 'pressure'), '4\n')  # critical: nothing new on M5
        p = self.run_m5('--', 'f.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5 内存紧张，改在 M1 跑', p.stdout)
        self.assertEqual(len(self.calls(self.th)), 6)
        self.assertEqual(self.calls(self.m1)[-1][0], 'exec vitest run f.test.ts --maxWorkers=2')

    def test_worker_budget_is_shared(self):
        self.limits(WORKERS_TOTAL=6, WORKERS_MAX=6)
        for i in (1, 2):
            self.hold(os.path.join(self.base, 'locks/worker-%d.lock' % i))
        p = self.run_m5('--', '--maxWorkers=6', 'g.test.ts')  # 4 free: at least half of 6, so it starts
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('4 of 6 workers free; starting with 4', p.stdout)
        self.assertEqual(self.calls(self.th)[-1][7], '4')
        for i in (3, 4):
            self.hold(os.path.join(self.base, 'locks/worker-%d.lock' % i))
        p = self.run_m5('--wait', '0', '--', '--maxWorkers=6', 'g.test.ts')  # 2 free: not enough, M1 runs it
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('no room on M5', p.stdout)
        self.assertIn('4 of 6 workers busy', p.stdout)
        self.assertIn('M5 没有空位（等了 0 秒），改在 M1 跑', p.stdout)
        self.assertEqual(len(self.calls(self.m1)), 3)

    def test_warning_halves_all_runs_together(self):
        self.limits(WORKERS_TOTAL=8, WORKERS_MAX=8)
        for i in (5, 6, 7, 8):  # another run took the upper half before the warning
            self.hold(os.path.join(self.base, 'locks/worker-%d.lock' % i))
        write(os.path.join(self.m5, 'pressure'), '2\n')
        p = self.run_m5('--wait', '0', '--', '--maxWorkers=8', 'w.test.ts')  # 4 for all runs, 4 taken: none left
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('memory pressure warning (level 2): 4 workers, 4 for all runs', p.stdout)
        self.assertIn('M5 没有空位', p.stdout)
        self.assertEqual(self.calls(self.th), [])

    def test_no_free_run_on_m5_goes_to_m1(self):
        self.limits(RUNS=1)
        lock = os.path.join(self.base, 'locks/slot-1.lock')
        write(lock.replace('.lock', '.owner'), '99990101-000000-deadbeef-1 deadbeef by met-1 since 10:00 (test, 8 workers) pid 1\n')
        self.hold(lock)
        self.hold(os.path.join(self.leases, '99990101-000000-deadbeef-1.lease'))  # its M1 side is attached
        p = self.run_m5('--wait', '0', '--', 'h.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('slot 1: 99990101-000000-deadbeef-1 deadbeef by met-1', p.stdout)
        self.assertIn('M5 没有空位', p.stdout)
        self.assertEqual(self.calls(self.th), [])
        self.assertEqual(len(self.calls(self.m1)), 3)
        self.assertEqual(self.run_m5('--on', 'm5', '--wait', '0', '--', 'h.test.ts').returncode, 4)

    def test_leftover_run_is_stopped_live_one_is_not(self):
        self.limits(RUNS=3)
        locks = os.path.join(self.base, 'locks')
        old, live = '20000101-000000-aaaaaaaa-1', '20000101-000000-bbbbbbbb-2'
        write(os.path.join(locks, 'slot-1.owner'), '%s aaaaaaaa by gone since 01:00 (test, 8 workers) pid 1\n' % old)
        write(os.path.join(locks, 'slot-2.owner'), '%s bbbbbbbb by here since 01:00 (test, 8 workers) pid 1\n' % live)
        leftover = self.hold(os.path.join(locks, 'slot-1.lock'), 'm5-run')
        attached = self.hold(os.path.join(locks, 'slot-2.lock'), 'm5-run')
        self.hold(os.path.join(self.leases, live + '.lease'))  # its M1 side is still there
        write(os.path.join(self.m5, 'leftovers'), 'p25_left_by_a\n')
        p = self.run_m5('--', 'i.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('stopping leftover run %s in slot 1' % old, p.stdout)
        self.assertNotIn(live, p.stdout)
        self.assertIsNotNone(leftover.wait(timeout=10))
        self.assertIsNone(attached.poll())
        self.assertIn('slot 1,', p.stdout)
        self.assertIsNone(read(os.path.join(self.m5, 'psql.stdin')))  # another run is going: schemas stay
        attached.kill()
        attached.wait()
        p = self.run_m5('--', 'i.test.ts')  # alone now: what interrupted runs left is dropped
        self.assertIn('clearing what earlier runs left: 1 schemas, 0 databases', p.stdout)
        self.assertIn('drop schema if exists "p25_left_by_a" cascade;', read(os.path.join(self.m5, 'psql.stdin')))

    def test_processes_left_in_a_slot_are_stopped_first(self):
        self.assertEqual(self.run_m5('--', 'l.test.ts').returncode, 0)
        wt = os.path.join(self.base, 'slots/slot-1')
        node = os.path.join(self.m5, '.local/opt/node-22.23.2/bin/node')  # "our" Node, standing in
        write(node, '#!/bin/sh\nsleep "$1"\n', 0o755)
        # test processes that outlived their run (no lock descriptor): one working in the worktree,
        # one elsewhere naming it, and a child of one; a user's process there is left alone
        strays = [subprocess.Popen([node, '120'], cwd=wt, close_fds=True),
                  subprocess.Popen([node, '120', wt + '/x'], cwd=self.tmp, close_fds=True)]
        user = subprocess.Popen([shutil.which('sleep'), '120'], cwd=wt, close_fds=True)
        for q in strays + [user]:
            self.addCleanup(q.kill)
        time.sleep(0.5)
        p = self.run_m5('--', 'l.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertRegex(p.stdout, r'stopping [34] test processes left in slot 1')
        for q in strays:
            self.assertIsNotNone(q.wait(timeout=10))
        self.assertIsNone(user.poll())

    @unittest.skipUnless(shutil.which('node'), 'node is not installed')
    def test_left_node_started_by_name_is_found(self):
        self.assertEqual(self.run_m5('--', 'l.test.ts').returncode, 0)
        wt = os.path.join(self.base, 'slots/slot-1')
        node = os.path.join(self.m5, '.local/opt/node-22.23.2/bin/node')
        os.symlink(os.path.realpath(shutil.which('node')), node)
        # "exec node …" from a pnpm shim: argv[0] is just "node", the command line names no path of ours
        stray = subprocess.Popen(['node', '-e', 'setTimeout(() => {}, 120000)'], cwd=wt, close_fds=True,
                                 env=dict(os.environ, PATH=os.path.dirname(node) + ':' + os.environ['PATH']))
        self.addCleanup(stray.kill)
        time.sleep(0.5)
        p = self.run_m5('--', 'l.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('stopping 1 test processes left in slot 1', p.stdout)
        self.assertIsNotNone(stray.wait(timeout=10))

    def test_codex_report_that_cannot_be_fetched_is_not_a_pass(self):
        out = os.path.join(self.tmp, 'r.md')
        write(out, 'an old report\n')
        write(self.codex, '#!/bin/sh\ncat >/dev/null\n', 0o755)  # Codex writes no report
        p = self.run_m5('codex', '--no-build', '-o', out, '--', 'x')
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn('could not fetch', p.stderr)
        self.assertFalse(os.path.exists(out))
        write(out, 'an old report\n')  # the same on M1
        write(os.path.join(self.m1, '.local/bin/codex'), '#!/bin/sh\ncat >/dev/null\n', 0o755)
        p = self.run_m5('codex', '--on', 'm1', '--no-build', '-o', out, '--', 'x')
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertFalse(os.path.exists(out))

    def test_vitest_is_capped_never_raised(self):
        self.assertEqual(self.run_m5('--', 'q.test.ts').returncode, 0)
        vitest = os.path.join(self.base, 'slots/slot-1/node_modules/.bin/vitest')
        self.assertIn('m5-test: vitest cap', read(vitest))
        for args, expected in ((['run', '--maxWorkers=1', 'a'], 'exec vitest run a --maxWorkers=1'),  # serial stays serial
                               (['run', '--maxWorkers', '9', 'a'], 'exec vitest run a --maxWorkers=4'),
                               (['run', 'a'], 'exec vitest run a --maxWorkers=4')):
            with self.subTest(args=args):
                path = os.path.join(self.m5, '.local/opt/node-22.23.2/bin') + ':' + os.environ['PATH']
                subprocess.run([vitest] + args, env=dict(os.environ, HOME=self.th, PATH=path, M5T_VITEST_CAP='4'), check=True,
                               capture_output=True, cwd=os.path.dirname(vitest))
                self.assertEqual(self.calls(self.th)[-1][0], expected)

    def test_what_m5_cannot_do_goes_to_m1(self):
        write(os.path.join(self.m5, 'pg-down'), '')  # the test Postgres does not start
        p = self.run_m5('--', 'r.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5 环境故障（the test Postgres did not start', p.stdout)
        self.assertIn('改在 M1 跑', p.stdout)
        self.assertEqual(self.calls(self.th), [])
        self.assertEqual(len(self.calls(self.m1)), 3)
        os.remove(os.path.join(self.m5, 'pg-down'))
        out = os.path.join(self.tmp, 'c.md')
        p = self.run_m5('codex', '--no-build', '-o', out, '--', 'x', M5T_CODEX=os.path.join(self.m5, 'no-codex'))
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5 环境故障（Codex is missing or not logged in', p.stdout)
        self.assertEqual(read(out), 'test report\n')  # from M1

    def test_stuck_run_on_m1_is_stopped(self):
        write(os.path.join(self.m5, 'offline'), '')
        write(os.path.join(self.m1, 'hang'), '')
        t0 = time.time()
        p = self.run_m5('--no-build', '--', 's.test.ts', M5_TEST_IDLE_SECONDS='2')
        self.assertLess(time.time() - t0, 25)
        self.assertEqual(p.returncode, 124, p.stdout + p.stderr)
        self.assertIn('printed nothing for 2s and was stopped as stuck', p.stderr)
        pid = int(read(os.path.join(self.m1, 'hang.pid')))  # it ignored TERM: the group got KILL
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.2)
        else:
            self.fail('the stuck test process is still running')

    def test_dropped_connection_reruns_on_m1(self):
        write(os.path.join(self.m5, 'drop'), '')
        write(os.path.join(self.m1, 'vitest.rc'), '1\n')
        p = self.run_m5('--', 'j.test.ts')
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)  # M1's verdict
        self.assertIn('M5 中断：连接断开或运行没有跑完（exit 255，不算测试失败），改在 M1 从头重跑', p.stdout)
        self.assertIn('done on M1', p.stdout)
        self.assertIn('finished on M1 (M5 dropped out mid-run; the result is from M1), exit 1', p.stdout)
        self.assertEqual(os.listdir(self.leases), [])
        self.assertEqual(self.run_m5('--on', 'm5', '--', 'j.test.ts').returncode, 4)

    def test_killed_caller_lets_go_of_m5(self):
        write(os.path.join(self.m5, 'hang'), '')
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, **GIT_ENV)
        p = subprocess.Popen([M5_TEST, '--', 'p.test.ts'], cwd=self.repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.addCleanup(p.stdout.close)
        for _ in range(100):  # until the run on "M5" has started and holds its lease
            if os.path.isdir(self.leases) and any(f.endswith('.lease') for f in os.listdir(self.leases)):
                break
            time.sleep(0.1)
        lease = [f for f in os.listdir(self.leases) if f.endswith('.lease')][0]
        p.kill()
        p.wait()
        held = 'import fcntl,sys\nf=open(sys.argv[1],"a")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)'
        for _ in range(50):  # the relay notices within a second and lets the lease go
            if subprocess.run([sys.executable, '-c', held, os.path.join(self.leases, lease)]).returncode == 0:
                break
            time.sleep(0.2)
        else:
            self.fail('the lease is still held after m5-test was killed')

    def test_run_stops_itself_after_m5_slept(self):
        write(os.path.join(self.th, 'hang'), '')  # the tests on "M5" hang, ignoring TERM
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, M5T_SLEEP_GAP='2', **GIT_ENV)
        m5 = subprocess.Popen([M5_TEST, '--', 'z.test.ts'], cwd=self.repo, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
        self.addCleanup(m5.kill)
        pidfile = os.path.join(self.th, 'hang.pid')
        for _ in range(100):
            if read(pidfile):
                break
            time.sleep(0.1)
        hung = int(read(pidfile))
        owner = read(os.path.join(self.base, 'locks/slot-1.owner'))
        run, runner = owner.split()[0], int(owner.split(' pid ')[1])
        ps = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True).stdout.split()
        parent = dict(zip(map(int, ps[0::2]), map(int, ps[1::2])))
        tree, added = {runner, parent[runner]}, True  # the guard is the runner's parent
        while added:
            added = False
            for p, pp in parent.items():
                if p not in tree and pp in tree:
                    tree.add(p)
                    added = True
        signal_all(tree, signal.SIGSTOP)  # the lid closes: everything of the run stops, the guard too ...
        time.sleep(3)
        signal_all(tree, signal.SIGCONT)  # ... and M5 wakes up
        out, _ = m5.communicate(timeout=60)
        for _ in range(50):
            try:
                os.kill(hung, 0)
            except OSError:
                break
            time.sleep(0.2)
        else:
            self.fail('the hung test process kept running after M5 woke up')
        self.assertIn('%s stopped after M5 was asleep' % run, read(os.path.join(self.base, 'stopped.log')) or '')
        self.assertIn('M5 中断', out)
        self.assertIn('finished on M1 (M5 dropped out mid-run', out)

    def test_run_waiting_for_room_stops_after_m5_slept(self):
        self.limits(RUNS=1)
        lock = os.path.join(self.base, 'locks/slot-1.lock')
        write(lock.replace('.lock', '.owner'), '20000101-000000-cccccccc-3 cccccccc by other since 01:00 (test, 8 workers) pid 1\n')
        other = self.hold(lock)
        self.hold(os.path.join(self.leases, '20000101-000000-cccccccc-3.lease'))  # another session's live run
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, M5T_SLEEP_GAP='2', **GIT_ENV)
        m5 = subprocess.Popen([M5_TEST, '--wait', '120', '--', 'y.test.ts'], cwd=self.repo, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(m5.kill)
        guard = None
        for _ in range(100):  # the run is queued on "M5", its guard above it
            ps = subprocess.run(['ps', '-axww', '-o', 'pid=,command='], capture_output=True, text=True).stdout
            found = [int(l.split()[0]) for l in ps.splitlines()  # this test's guard, not the runner (whose text holds it too)
                     if 'import os,select,signal' in l and 'bash -c' not in l.split('import os,select,signal')[0]
                     and self.base + '/stopped.log' in l]
            if found:
                guard = found[0]
                break
            time.sleep(0.1)
        self.assertIsNotNone(guard)
        time.sleep(1)
        ps = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True).stdout.split()
        parent = dict(zip(map(int, ps[0::2]), map(int, ps[1::2])))
        tree, added = {guard}, True
        while added:
            added = False
            for p, pp in parent.items():
                if p not in tree and pp in tree:
                    tree.add(p)
                    added = True
        signal_all(tree, signal.SIGSTOP)
        time.sleep(3)
        signal_all(tree, signal.SIGCONT)
        out, _ = m5.communicate(timeout=60)
        self.assertIn('stopped after M5 was asleep', read(os.path.join(self.base, 'stopped.log')) or '')
        self.assertEqual(self.calls(self.th), [])  # it never started on M5
        self.assertIsNone(other.poll())  # the other session's run is not ours to stop
        self.assertIn('finished on M1 (M5 dropped out mid-run', out)

    def test_closing_line_then_slept_is_no_verdict(self):
        write(os.path.join(self.m5, 'slept'), '')  # the guard saw the sleep after the run had printed its result
        write(os.path.join(self.m1, 'vitest.rc'), '1\n')
        p = self.run_m5('--', 's.test.ts')
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)  # M1's verdict, not M5's 0
        self.assertIn('done on M5', p.stdout)
        self.assertIn('M5 中断：运行中 M5 睡过（不算测试失败），改在 M1 从头重跑', p.stdout)
        self.assertIn('finished on M1 (M5 dropped out mid-run', p.stdout)

    def test_detached_process_of_a_run_goes_with_it(self):
        write(os.path.join(self.th, 'detach'), '')  # a test starts something in a session of its own
        write(os.path.join(self.th, 'postgres-too'), '')
        standin = os.path.join(self.m5, PG, 'postgres-standin')  # anything from the test Postgres' bin directory
        write(standin, '#!/usr/bin/python3\nimport os, sys, time\nos.setsid()  # as pg_ctl starts the postmaster\n'
                       'open(os.environ["HOME"] + "/postgres.pid", "w").write(str(os.getpid()))\ntime.sleep(int(sys.argv[1]))\n', 0o755)
        # a localised ps (lstart in Chinese) must not hide the run's processes
        p = self.run_m5('--', 'u.test.ts', M5T_SLEEP_GAP='2', LC_ALL='zh_CN.UTF-8', LANG='zh_CN.UTF-8')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('finished on M5, exit 0', p.stdout)
        for name in ('detached.pid', 'detached-child.pid'):
            pid = int(read(os.path.join(self.th, name)))
            for _ in range(50):
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
                time.sleep(0.2)
            else:
                os.kill(pid, signal.SIGKILL)
                self.fail('%s outlived the run' % name)
        postgres = int(read(os.path.join(self.th, 'postgres.pid')))
        self.addCleanup(signal_all, [postgres], signal.SIGKILL)
        os.kill(postgres, 0)  # still there: the test Postgres is no process of the run

    def test_short_pause_and_normal_end(self):
        env = dict(os.environ, HOME=self.m1, M5_FAKE_HOME=self.m5, M5_TEST_SSH=self.ssh, M5T_SLEEP_GAP='4', **GIT_ENV)
        write(os.path.join(self.th, 'hang'), '')
        write(os.path.join(self.th, 'hang.seconds'), '3')
        m5 = subprocess.Popen([M5_TEST, '--', 'v.test.ts'], cwd=self.repo, env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
        self.addCleanup(m5.kill)
        for _ in range(100):
            if read(os.path.join(self.th, 'hang.pid')):
                break
            time.sleep(0.1)
        owner = read(os.path.join(self.base, 'locks/slot-1.owner'))
        runner = int(owner.split(' pid ')[1])
        ps = subprocess.run(['ps', '-axo', 'pid=,ppid='], capture_output=True, text=True).stdout.split()
        parent = dict(zip(map(int, ps[0::2]), map(int, ps[1::2])))
        guard = parent[runner]
        signal_all([guard, runner], signal.SIGSTOP)  # a pause well under the limit
        time.sleep(0.5)
        signal_all([guard, runner], signal.SIGCONT)
        out, _ = m5.communicate(timeout=60)
        self.assertIn('finished on M5, exit 0', out)  # not stopped
        self.assertFalse(os.path.exists(os.path.join(self.base, 'stopped.log')))
        time.sleep(0.5)
        with self.assertRaises(ProcessLookupError):  # the guard went with the run
            os.kill(guard, 0)

    def test_silent_run_reruns_on_m1(self):
        write(os.path.join(self.m5, 'hang'), '')
        t0 = time.time()
        p = self.run_m5('--', 'k.test.ts', M5_TEST_IDLE_SECONDS='2')
        self.assertLess(time.time() - t0, 25)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('m5-test: no output for 2s', p.stdout)
        self.assertIn('M5 中断：2 秒没有输出（不算测试失败），改在 M1 从头重跑', p.stdout)
        self.assertEqual(len(self.calls(self.m1)), 3)

    def test_next_run_reuses_the_slot_clean(self):
        self.assertEqual(self.run_m5('--', 'h.test.ts').returncode, 0)
        wt = os.path.join(self.base, 'slots/slot-1')
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
        prompt = read(os.path.join(self.th, 'codex.prompt'))
        self.assertTrue(prompt.startswith('【运行环境，m5-test 附加】你在 M5 测试机上'), prompt)
        self.assertIn('不要调用 m5-test', prompt)
        self.assertTrue(prompt.endswith('\n\n写测试并运行\n'), prompt)
        self.assertEqual(read(os.path.join(self.th, 'codex.workers')), '4\n')  # Codex's vitest runs are capped too
        args = read(os.path.join(self.th, 'codex.args'))
        for part in ('exec --ephemeral -C %s/slots/slot-1 ' % self.base, '-m gpt-6-astra -c model_reasoning_effort=max',
                     '-c allow_login_shell=false -c shell_environment_policy.inherit=all',
                     '-s workspace-write -c sandbox_workspace_write.network_access=true'):
            self.assertIn(part, args)
        self.assertEqual(len(self.calls(self.th)), 2)  # install and build, before Codex
        self.assertEqual(self.run_m5('--no-build', '--', 'x.test.ts').returncode, 0)  # the next run gets a clean slot
        wt = os.path.join(self.base, 'slots/slot-1')
        self.assertFalse(os.path.exists(os.path.join(wt, 'new.test.ts')))
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=no', cwd=wt), '')

    def test_codex_full_access_runs_on_m1_unless_asked(self):
        out = os.path.join(self.tmp, 'f.md')
        p = self.run_m5('codex', '--browser', '--full-access', '--no-build', '-o', out, '--', 'browser tests')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('codex --full-access 在 M1 跑', p.stdout)
        self.assertIn('-s danger-full-access', read(os.path.join(self.m1, 'codex.args')))
        self.assertIsNone(read(os.path.join(self.th, 'codex.args')))
        p = self.run_m5('codex', '--browser', '--full-access', '--on', 'm5', '--no-build', '-o', out, '--', 'browser tests')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        args = read(os.path.join(self.th, 'codex.args'))
        self.assertIn('-s danger-full-access', args)
        self.assertNotIn('workspace-write', args)
        p = self.run_m5('codex', '--browser', '--no-build', '-o', out, '--', 'browser tests')  # cannot work in the sandbox
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("browser tests do not start in Codex's sandbox", p.stderr)
        self.assertEqual(self.run_m5('--full-access', '--', 'x').returncode, 2)  # not for plain tests

    def test_codex_on_m1_has_full_access(self):
        write(os.path.join(self.m5, 'offline'), '')
        out = os.path.join(self.tmp, 'm1.md')
        p = self.run_m5('codex', '--no-build', '-o', out, '--', 'test it')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('-s danger-full-access', read(os.path.join(self.m1, 'codex.args')))
        self.assertEqual(read(out), 'test report\n')
        self.assertIn('-m gpt-6-astra ', read(os.path.join(self.m1, 'codex.args')))
        p = self.run_m5('codex', '--model', 'gpt-6.1-sol', '--no-build', '-o', out, '--', 'test it')  # Codex-saving mode
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('-m gpt-6.1-sol ', read(os.path.join(self.m1, 'codex.args')))
        self.assertEqual(self.run_m5('codex', '--model', 'x; rm', '-o', out, '--', 'y').returncode, 2)
        prompt = read(os.path.join(self.m1, 'codex.prompt'))
        self.assertTrue(prompt.startswith('【运行环境，m5-test 附加】你在 M1 上'), prompt)
        self.assertIn('不要调用 m5-test', prompt)

    def test_rejects_bad_arguments(self):
        for args in (['-e', 'ALLRICE_API_KEY=x', '--', 'a'], ['-e', 'PATH=/x', '--', 'a'], ['nope', '--', 'a'],
                     ['-e', 'ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_dev', '--', 'a'],
                     ['-e', 'ALLRICE_RUN_X=postgres://u:p@host/db', '--', 'a'],
                     ['--wait', 'soon', '--', 'a'], ['--wait', '08', '--', 'a'], ['--build', '', '--', 'a'],
                     ['codex', '--', 'no -o']):
            with self.subTest(args=args):
                p = self.run_m5(*args)
                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertEqual(self.calls(self.th) + self.calls(self.m1), [])

    def test_exit_code_after_a_late_drop_comes_from_the_run(self):
        write(os.path.join(self.m5, 'late-drop'), '')  # the connection broke after the closing line
        write(os.path.join(self.th, 'vitest.rc'), '1\n')
        p = self.run_m5('--', 'm.test.ts')
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn('finished on M5, exit 1', p.stdout)
        self.assertEqual(self.calls(self.m1), [])

    def test_custom_build_and_status(self):
        p = self.run_m5('--build', 'echo built >built.txt', '--', 'n.test.ts')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(read(os.path.join(self.base, 'slots/slot-1/built.txt')), 'built\n')
        self.assertEqual([c[0] for c in self.calls(self.th)][1:], ['exec vitest run n.test.ts --maxWorkers=8'])
        p = self.run_m5('status')
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('M5: ready', p.stdout)
        self.assertIn('limits: 48G, 16 workers in all (16 usable), 8 per run by default, at most 12, 4 runs', p.stdout)
        self.assertIn('M1: ready', p.stdout)
        write(os.path.join(self.m5, 'offline'), '')
        self.assertIn('M5: M5 不在线', self.run_m5('status').stdout)

    def test_uncommitted_changes_are_named(self):
        write(os.path.join(self.repo, 'README.md'), 'dirty\n')
        p = self.run_m5('--', 'i.test.ts')
        self.assertIn('uncommitted changes in %s are not part of this run' % self.repo, p.stdout)
        self.assertEqual(read(os.path.join(self.base, 'slots/slot-1/README.md')), 'hi\n')


if __name__ == '__main__':
    unittest.main()
