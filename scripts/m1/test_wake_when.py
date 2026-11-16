import concurrent.futures
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch


TOOL = Path(__file__).with_name('wake-when')
THREADS = Path(__file__).with_name('wake-when.threads')
THREAD = '01a1d8ae-d108-7a11-8d08-f54bc8f90df6'
OTHER = '01a1d8ac-5b8e-7fd3-a9b3-bf19a806ceb9'


def running(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


class WakeWhen(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.base = self.home / 'allrice-dev'
        self.base.mkdir()
        (self.base / 'wake-when.threads').write_text(THREADS.read_text())
        self.codex = self.home / '.local/bin/codex'
        self.codex.parent.mkdir(parents=True)
        self.codex.write_text('#!' + sys.executable + '''
import json, os, sys, time
from pathlib import Path
home = Path.home()
if os.environ.get('QUEUE_HANG'):
    time.sleep(60)
with (home / 'notifications.jsonl').open('a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
sys.exit(int(os.environ.get('QUEUE_EXIT', '0')))
''')
        self.codex.chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.home))
        self.started = []
        self.addCleanup(self.stop_workers)

    def stop_workers(self):
        for item in self.started:
            if running(item['pid']):
                os.kill(item['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 8
        while any(running(item['pid']) for item in self.started) and time.monotonic() < deadline:
            time.sleep(0.05)

    def invoke(self, source, label='CI check', thread=THREAD, timeout='5s', extra_env=None,
               command=None, options=()):
        timeout_args = ['--timeout', timeout] if timeout else []
        return subprocess.run([sys.executable, str(TOOL), '--thread', thread, '--label', label,
                               *timeout_args, *options, '--', *(command or [sys.executable, '-c', source])],
                              env=dict(self.env, **(extra_env or {})), cwd=self.home,
                              capture_output=True, text=True, timeout=12)

    def start(self, source, **kwargs):
        result = self.invoke(source, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        item = json.loads(result.stdout)
        self.started.append(item)
        return item

    def finished(self, item):
        deadline = time.monotonic() + 20
        path = Path(item['result'])
        while time.monotonic() < deadline:
            state = json.loads(path.read_text())
            if state.get('finishedAt') and not running(item['pid']):
                return state
            time.sleep(0.05)
        self.fail('wait worker did not finish: ' + path.read_text())

    def notifications(self):
        path = self.home / 'notifications.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_released(self, item):
        self.assertFalse(running(item['pid']))
        self.assertEqual(list((self.base / 'qa/wake-when/.locks').glob('*.lock')), [])

    def test_detached_success_keeps_cwd_and_argv_and_notifies_once(self):
        item = self.start('import os,time; from pathlib import Path; '
                          '\nwhile not Path("continue").exists(): time.sleep(.02)\n'
                          'print(os.getcwd()); print("$(false); keep literal")')
        self.assertTrue(running(item['pid']))
        (self.home / 'continue').touch()
        state = self.finished(item)
        self.assertEqual((state['outcome'], state['commandExitCode'], state['notification']), ('成功', 0, 'sent'))
        args = self.notifications()[0]
        self.assertEqual(args[:3], ['queue', '--thread', THREAD])
        self.assertIn('CI check 结束：成功（真实结论 exit 0；等待命令退出码 0）', args[4])
        self.assertNotIn('最后 30 行', args[4])
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn(str(self.home), Path(item['log']).read_text())
        self.assertIn('$(false); keep literal', Path(item['log']).read_text())
        self.assertEqual(Path(item['log']).stat().st_mode & 0o777, 0o600)
        self.assert_released(item)

    def test_failure_notifies_exit_code_and_only_last_30_lines(self):
        item = self.start('import sys; [print("L"+str(i)) for i in range(40)]; sys.exit(7)')
        state = self.finished(item)
        self.assertEqual((state['outcome'], state['commandExitCode']), ('等待失败，任务状态未知', 7))
        message = self.notifications()[0][4]
        self.assertIn('退出码 7', message)
        self.assertIn('\nL10\n', message)
        self.assertNotIn('\nL9\n', message)
        self.assertTrue(message.endswith('L39'))
        self.assertIn('L0\n', Path(item['log']).read_text())
        self.assert_released(item)

    def test_timeout_stops_term_ignoring_command_and_child(self):
        source = '''import os,signal,subprocess,sys,time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
Path('children.json').write_text(__import__('json').dumps([os.getpid(),child.pid]))
time.sleep(60)
'''
        item = self.start(source, timeout='1s')
        state = self.finished(item)
        self.assertEqual((state['outcome'], state['commandExitCode']), ('等待失败，任务状态未知', 124))
        self.assertIn('等待命令退出码 124；超时', self.notifications()[0][4])
        for pid in json.loads((self.home / 'children.json').read_text()):
            self.assertFalse(running(pid), str(pid))
        self.assert_released(item)

    def test_success_also_cleans_up_same_group_orphan(self):
        item = self.start('import subprocess,sys; from pathlib import Path; '
                          'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); '
                          'Path("orphan.pid").write_text(str(p.pid))')
        self.assertEqual(self.finished(item)['commandExitCode'], 0)
        self.assertFalse(running(int((self.home / 'orphan.pid').read_text())))
        self.assert_released(item)

    def test_timeout_allows_real_m5_relay_to_clean_its_separate_child_group(self):
        m5_source = (TOOL.parent / 'm5-test').read_text()
        relay = m5_source.split('relay() {', 1)[1].split('\n}\n', 1)[0]
        wrapper = self.home / 'relay.sh'
        wrapper.write_text('STOPPED=75\nrelay() {' + relay + '\n}\n'
                           'relay 0 "$HOME/relay.log" "$@"\n')
        def release_fixture_child():
            path = self.home / 'relay-child.pid'
            if path.exists() and running(int(path.read_text())):
                try:
                    os.killpg(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.addCleanup(release_fixture_child)
        item = self.start('import os,sys; os.execv("/bin/bash", ["bash", "relay.sh", sys.executable, "-c", '
                          '"import os,signal,time; from pathlib import Path; '
                          'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                          'Path(\\\"relay-child.pid\\\").write_text(str(os.getpid())); time.sleep(60)"])',
                          timeout='2s')
        state = self.finished(item)
        self.assertEqual((state['commandExitCode'], state['notification']), (124, 'sent'))
        child = int((self.home / 'relay-child.pid').read_text())
        self.assertFalse(running(child), 'm5 relay child must exit before the completion receipt')
        self.assert_released(item)

    def test_same_label_is_global_and_concurrent_launch_is_atomic(self):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            source = 'import time; from pathlib import Path\nwhile not Path("continue").exists(): time.sleep(.02)'
            results = list(pool.map(lambda thread: self.invoke(source, thread=thread),
                                    [THREAD, OTHER]))
        self.assertEqual(sorted(result.returncode for result in results), [0, 2])
        item = json.loads(next(result.stdout for result in results if result.returncode == 0))
        self.started.append(item)
        (self.home / 'continue').touch()
        self.finished(item)
        self.assertEqual(len(self.notifications()), 1)
        self.assert_released(item)
        second = self.start('pass')
        self.finished(second)
        self.assertEqual(len(self.notifications()), 2)

    def test_whitelist_rejects_unknown_thread_and_reload_uses_updated_file(self):
        replacement = '00000000-0000-4000-8000-000000000007'
        refused = self.invoke('raise Exception("must not run")', thread=replacement)
        self.assertEqual(refused.returncode, 2)
        self.assertFalse((self.base / 'qa').exists())
        path = self.base / 'wake-when.threads'
        path.write_text(path.read_text().replace(THREAD, replacement))
        self.assertEqual(self.invoke('pass').returncode, 2)
        item = self.start('pass', thread=replacement)
        self.finished(item)
        self.assertEqual(self.notifications()[0][2], replacement)
        self.assert_released(item)

    def test_malformed_whitelist_and_invalid_timeout_fail_before_detaching(self):
        for timeout in ['0', '-1', 'nan', '0h', '1.5h']:
            self.assertEqual(self.invoke('pass', timeout=timeout).returncode, 2)
        (self.base / 'wake-when.threads').write_text('only ' + THREAD + '\n')
        self.assertEqual(self.invoke('pass').returncode, 2)
        self.assertEqual(self.notifications(), [])

    def test_default_timeout_is_three_hours(self):
        item = self.start('pass', timeout=None)
        self.assertEqual(self.finished(item)['timeoutSeconds'], 10800)
        self.assert_released(item)

    def test_removed_thread_is_not_notified_after_wait(self):
        item = self.start('import time; from pathlib import Path\nwhile not Path("continue").exists(): time.sleep(.02)')
        path = self.base / 'wake-when.threads'
        path.write_text(path.read_text().replace(THREAD, '00000000-0000-4000-8000-000000000007'))
        (self.home / 'continue').touch()
        self.assertEqual(self.finished(item)['notification'], 'failed')
        self.assertEqual(self.notifications(), [])
        self.assert_released(item)

    def test_queue_failure_is_recorded_and_releases_label_without_rerunning_command(self):
        item = self.start('print("one execution")', extra_env={'QUEUE_EXIT': '9'})
        state = self.finished(item)
        self.assertEqual((state['notification'], state['queueExitCode']), ('failed', 9))
        self.assertEqual(len(self.notifications()), 1)
        self.assertEqual(Path(item['log']).read_text().count('one execution'), 1)
        self.assert_released(item)

    def test_sigterm_interrupt_notifies_and_cleans_up(self):
        item = self.start('import os,time; from pathlib import Path; Path("child.pid").write_text(str(os.getpid())); time.sleep(60)')
        deadline = time.monotonic() + 3
        while not (self.home / 'child.pid').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        os.kill(item['pid'], signal.SIGTERM)
        state = self.finished(item)
        self.assertEqual(state['commandExitCode'], 143)
        self.assertIn('退出码 143', self.notifications()[0][4])
        self.assertFalse(running(int((self.home / 'child.pid').read_text())))
        self.assert_released(item)

    def test_sigint_during_timeout_cleanup_cannot_leave_command_running(self):
        item = self.start('import os,signal,time; from pathlib import Path; '
                          'Path("child.pid").write_text(str(os.getpid())); '
                          'signal.signal(signal.SIGTERM, lambda *_: Path("term-received").touch()); '
                          'time.sleep(60)', timeout='1s')
        def release_fixture_child():
            path = self.home / 'child.pid'
            if path.exists() and running(int(path.read_text())):
                try:
                    os.killpg(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.addCleanup(release_fixture_child)
        deadline = time.monotonic() + 5
        while not (self.home / 'term-received').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.home / 'term-received').exists())
        os.kill(item['pid'], signal.SIGINT)
        state = self.finished(item)
        self.assertEqual((state['commandExitCode'], state['notification']), (130, 'sent'))
        self.assertFalse(running(int((self.home / 'child.pid').read_text())))
        self.assert_released(item)

    def test_stale_unlocked_file_is_removed_on_next_launch(self):
        directory = self.base / 'qa/wake-when/.locks'
        directory.mkdir(parents=True)
        stale = directory / 'old.lock'
        stale.write_text('reboot left a file, not a held lock')
        item = self.start('pass')
        self.finished(item)
        self.assertFalse(stale.exists())
        self.assert_released(item)

    def fake_ci(self):
        gh = self.home / 'gh'
        gh.write_text('#!' + sys.executable + '''
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
with Path('gh-calls.jsonl').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
assert args[0] == 'run' and args[1] in ('watch', 'view'), args
assert args[2] == '43868459286' and args[3:5] == ['--repo', 'semiok/allrice'], args
mode = os.environ.get('CI_MODE', 'reconnect')
count_path = Path('watch-count')
count = int(count_path.read_text()) if count_path.exists() else 0
if args[1] == 'watch':
    count += 1
    count_path.write_text(str(count))
    if count == 2 and mode == 'reconnect':
        Path('reattached').touch()
        while not Path('ci-done').exists(): time.sleep(.02)
    if mode == 'watch-hang': time.sleep(60)
    if mode == 'watch-zero': sys.exit(0)
    print('failed to get run: EOF', flush=True)
    sys.exit(1)
if mode == 'query-error' and count == 1:
    print('HTTP 503: temporarily unavailable', file=sys.stderr)
    sys.exit(1)
if mode == 'malformed':
    print('invalid JSON')
    sys.exit(0)
status = 'completed' if count >= 2 or mode in ('success', 'failure', 'cancelled', 'wrong-id') else 'in_progress'
print(json.dumps(dict(databaseId=7 if mode == 'wrong-id' else 43868459286,
                     status=status, conclusion=mode if mode in ('failure','cancelled') else 'success')))
''')
        gh.chmod(0o755)
        return [str(gh), 'run', 'watch', '43868459286', '--repo', 'semiok/allrice', '--exit-status']

    def test_eof_reattaches_same_ci_without_early_wake_then_reports_real_success(self):
        command = self.fake_ci()
        item = self.start('', command=command, timeout='15s')
        deadline = time.monotonic() + 9
        while not (self.home / 'reattached').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.home / 'reattached').exists())
        self.assertEqual(self.notifications(), [], 'EOF and in_progress must not wake the thread')
        self.assertTrue(running(item['pid']))
        (self.home / 'ci-done').touch()
        state = self.finished(item)
        self.assertEqual(state['commandExitCode'], 1, 'even final watch EOF must not override API success')
        self.assertEqual(state['task'], dict(status='completed', conclusion='success', exitCode=0))
        self.assertEqual(state['verificationAttempts'], 2)
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('真实结论 success', self.notifications()[0][4])
        calls = [json.loads(line) for line in (self.home / 'gh-calls.jsonl').read_text().splitlines()]
        self.assertEqual([call[:2] for call in calls], [['run', 'watch'], ['run', 'view']] * 2)
        self.assertEqual([call for call in calls if call[1] == 'watch'], [command[1:]] * 2)
        self.assertIn('EOF', Path(item['log']).read_text())
        self.assertEqual(json.loads((Path(item['result']).parent / 'ci-state-1.json').read_text())['status'], 'in_progress')
        self.assert_released(item)

    def test_ci_terminal_failure_and_cancelled_are_not_retried(self):
        for conclusion in ['failure', 'cancelled']:
            with self.subTest(conclusion=conclusion):
                command = self.fake_ci()
                item = self.start('', command=command, extra_env={'CI_MODE': conclusion})
                state = self.finished(item)
                self.assertEqual(state['outcome'], '失败')
                self.assertEqual(state['task']['conclusion'], conclusion)
                self.assertEqual(state['verificationAttempts'], 1)
                self.assertIn('真实结论 ' + conclusion, self.notifications()[-1][4])
                self.assert_released(item)

    def test_status_query_network_error_is_retried(self):
        item = self.start('', command=self.fake_ci(), timeout='15s', extra_env={'CI_MODE': 'query-error'})
        state = self.finished(item)
        self.assertEqual(state['task']['conclusion'], 'success')
        self.assertEqual(state['verificationAttempts'], 2)
        self.assertIn('HTTP 503', Path(item['log']).read_text())
        self.assertEqual(len(self.notifications()), 1)
        self.assert_released(item)

    def test_interrupt_during_ci_backoff_preserves_watch_exit_code(self):
        item = self.start('', command=self.fake_ci(), timeout='15s')
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if 'reconnect/check after' in Path(item['log']).read_text():
                break
            time.sleep(.02)
        self.assertIn('reconnect/check after', Path(item['log']).read_text())
        os.kill(item['pid'], signal.SIGTERM)
        state = self.finished(item)
        self.assertEqual(state['commandExitCode'], 1)
        self.assertEqual(state['interruptSignal'], signal.SIGTERM)
        self.assertEqual(state['task']['status'], 'unknown')
        self.assertIn('等待命令退出码 1', self.notifications()[0][4])
        self.assertIn('等待被信号 15 中断', self.notifications()[0][4])
        self.assert_released(item)

    def test_ci_unverified_timeout_is_unknown_even_with_zero_watch_exit(self):
        for mode in ['watch-zero', 'wrong-id', 'malformed', 'watch-hang']:
            with self.subTest(mode=mode):
                item = self.start('', command=self.fake_ci(), timeout='1s', extra_env={'CI_MODE': mode})
                state = self.finished(item)
                self.assertEqual(state['task'], dict(status='unknown'))
                self.assertTrue(state['waitTimedOut'])
                self.assertIn('等待失败，CI 状态未知', self.notifications()[-1][4])
                self.assertIn('超时', self.notifications()[-1][4])
                self.assert_released(item)

    def test_ci_reconnect_cap_and_backoff_do_not_reset_total_timeout(self):
        loader = importlib.machinery.SourceFileLoader('wake_when_under_test', str(TOOL))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        command = self.fake_ci()
        args = SimpleNamespace(command=command, timeout=200, ci=module.ci_target(command), m5=False, terminal_file=None)
        state = {}
        elapsed = [0]
        def advance(seconds):
            elapsed[0] += seconds
        def watch(*_args, **_kwargs):
            advance(10)
            return 1, False
        with patch.object(module, 'run_group', side_effect=watch) as run, \
             patch.object(module, 'verify_ci', return_value=None) as verify, \
             patch.object(module.time, 'monotonic', side_effect=lambda: elapsed[0]), \
             patch.object(module.time, 'sleep', side_effect=advance) as sleep:
            self.assertIsNone(module.wait_for_result(args, self.home, io.BytesIO(), state))
        self.assertEqual(run.call_count, 5)
        self.assertEqual(verify.call_count, 5)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 15, 30, 60])
        self.assertTrue(all(call.args[0] == command for call in run.call_args_list))
        self.assertEqual([call.args[1] for call in run.call_args_list], [200, 185, 160, 120, 50])
        self.assertFalse(state['waitTimedOut'])
        self.assertEqual(state['verificationAttempts'], 5)

    def test_terminal_file_confirms_external_work_after_wait_command_failed_without_rerun(self):
        receipt = self.home / 'terminal.json'
        source = 'from pathlib import Path; Path("executed").touch(); print("SSH EOF"); raise SystemExit(1)'
        item = self.start(source, timeout='12s',
                          options=['--terminal-file', str(receipt), '--terminal-id', 'deployment-123'])
        deadline = time.monotonic() + 3
        while not (self.home / 'executed').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue((self.home / 'executed').exists())
        self.assertEqual(self.notifications(), [])
        receipt.write_text(json.dumps(dict(id='deployment-123', status='completed', exitCode=7)))
        state = self.finished(item)
        self.assertEqual(state['task']['exitCode'], 7)
        self.assertIn('真实结论 exit 7；等待命令退出码 1', self.notifications()[0][4])
        self.assertEqual(Path(item['log']).read_text().count('SSH EOF'), 1)
        self.assert_released(item)

    def test_terminal_receipt_must_be_fresh_and_match_task(self):
        receipt = self.home / 'terminal.json'
        options = ['--terminal-file', str(receipt), '--terminal-id', 'wanted']
        receipt.write_text(json.dumps(dict(id='wanted', status='completed', exitCode=0)))
        self.assertEqual(self.invoke('pass', options=options).returncode, 2)
        receipt.unlink()
        for record in [dict(id='other', status='completed', exitCode=0),
                       dict(id='wanted', status='running', exitCode=0),
                       dict(id='wanted', status='completed', exitCode=True)]:
            with self.subTest(record=record):
                source = 'from pathlib import Path; Path("terminal.json").write_text(%r)' % json.dumps(record)
                item = self.start(source, timeout='1s', options=options)
                self.assertEqual(self.finished(item)['task']['status'], 'unknown')
                self.assert_released(item)
                receipt.unlink()

    def test_ci_requires_fixed_run_repo_and_rejects_external_receipt_override(self):
        command = self.fake_ci()
        for argv in [command[:-1], command[:4], command[:3] + ['latest'] + command[4:], command + ['--web']]:
            self.assertEqual(self.invoke('', command=argv).returncode, 2)
        self.assertEqual(self.invoke('', command=command, options=[
            '--terminal-file', str(self.home / 'terminal.json'), '--terminal-id', 'bypass']).returncode, 2)
        self.assertFalse((self.base / 'qa').exists())

    def test_complete_m5_launch_and_wait_reads_real_wrapper_result_and_releases_lease(self):
        # Reuse the real m5-test/m5-run fixture: only SSH, pnpm and system probes
        # are fake. Both homes and every slot/lease are isolated from real M5.
        import test_m5_test as m5
        fixture = m5.M5Test()
        self.addCleanup(lambda: (self.stop_workers(), fixture.doCleanups()))
        fixture.setUp()
        queue_source = self.codex.read_text()
        self.home = Path(fixture.m1)
        self.base = self.home / 'allrice-dev'
        self.base.mkdir(exist_ok=True)
        (self.base / 'wake-when.threads').write_text(THREADS.read_text())
        self.codex = self.home / '.local/bin/codex'
        self.codex.write_text(queue_source)
        self.env.update(HOME=str(self.home), M5_FAKE_HOME=fixture.m5,
                        M5_TEST_SSH=fixture.ssh, M5_TEST_REPO=fixture.repo, **m5.GIT_ENV)
        gated = m5.PNPM.replace('  exec)', '  exec) touch "$HOME/wake-running"; '
                               'while [ ! -e "$HOME/wake-release" ]; do sleep .05; done;')
        m5.write(str(self.home / '.local/opt/node-22.23.2/bin/pnpm'), gated, 0o755)
        m5.write(str(Path(fixture.m5) / '.local/opt/node-22.23.2/bin/pnpm'), gated, 0o755)
        for exit_code in [0, 1]:
            with self.subTest(exit_code=exit_code):
                test_home = Path(fixture.th)
                m5.write(str(test_home / 'vitest.rc'), str(exit_code))
                for name in ['wake-running', 'wake-release']:
                    (test_home / name).unlink(missing_ok=True)
                item = self.start('', timeout='6h', command=[m5.M5_TEST, fixture.sha, '--on', 'm5',
                                  '--wait', '0', '--no-build', '--', '--maxWorkers=1', 'short.test.ts'])
                deadline = time.monotonic() + 15
                while not (test_home / 'wake-running').exists() and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertTrue((test_home / 'wake-running').exists(), Path(item['log']).read_text())
                self.assertEqual(len(self.notifications()), exit_code, 'no wake before the batch ends')
                self.assertTrue(running(item['pid']))
                (test_home / 'wake-release').touch()
                state = self.finished(item)
                self.assertEqual(state['timeoutSeconds'], 21600)
                self.assertEqual(state['commandExitCode'], exit_code)
                self.assertEqual(state['task']['exitCode'], exit_code)
                self.assertEqual(state['task']['host'], 'M5')
                result_file = Path(state['task']['resultFile'])
                self.assertIn('m5-test: finished on M5, exit %s' % exit_code, result_file.read_text())
                self.assertIn('真实结论 M5 exit %s' % exit_code, self.notifications()[-1][4])
                self.assertIn(str(result_file), self.notifications()[-1][4])
                self.assertEqual(list(Path(fixture.leases).glob('*.lease')), [])
                self.assertFalse(running(state['commandPid']))
                self.assert_released(item)
        self.assertEqual(len([call for call in fixture.calls(fixture.th) if call[0].startswith('exec vitest')]), 2)

    def test_m5_requires_current_pid_matching_final_result_file_even_when_command_exits_zero(self):
        command = self.home / 'm5-test'
        command.write_text('#!' + sys.executable + '''
import os
from pathlib import Path
root=Path.home()/'allrice-dev/qa/m5-test'
root.mkdir(parents=True,exist_ok=True)
mode=os.environ['M5_RECEIPT']
pid=os.getpid() if mode!='other-run' else 1
path=root/('20261116-140000-12345678-%s.log'%pid)
line='m5-test: finished on M5, exit 0; log %s'%path
if mode!='missing': path.write_text(line+'\\n' if mode!='partial' else 'm5-test: done on M5 (batch), exit 0\\n')
if mode=='old': os.utime(path,(1,1))
print(line)
''')
        command.chmod(0o755)
        for mode in ['other-run', 'missing', 'partial', 'old']:
            with self.subTest(mode=mode):
                item = self.start('', command=[str(command)], extra_env={'M5_RECEIPT': mode})
                state = self.finished(item)
                self.assertEqual(state['commandExitCode'], 0)
                self.assertEqual(state['task']['status'], 'unknown')
                self.assertIn('等待失败，任务状态未知', self.notifications()[-1][4])
                self.assert_released(item)

    def test_installer_seeds_whitelist_once_and_preserves_thread_rotation_on_upgrade(self):
        repo = self.home / 'repo'
        source = repo / 'scripts/m1'
        source.mkdir(parents=True)
        for name in ['install', 'lib.sh']:
            (source / name).write_text((TOOL.parent / name).read_text())

        def git(*args):
            return subprocess.run(['git', '-C', str(repo), *args], env=self.env,
                                  check=True, capture_output=True, text=True).stdout.strip()

        git('init', '-q')
        git('config', 'user.name', 'Tool test')
        git('config', 'user.email', 'tool-test@example.invalid')
        git('add', '.')
        git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'installer fixture')
        live = self.base / 'wake-when.threads'
        live.unlink()

        def install_prepared_version():
            # A fully prepared version skips installer syntax/unit checks, so this
            # exercises the real activation path without recursively running tests.
            version = self.base / 'tools' / git('rev-parse', 'HEAD')
            version.mkdir(parents=True)
            (version / 'wake-when.threads').write_text(THREADS.read_text())
            result = subprocess.run(['/bin/bash', str(source / 'install')], env=self.env,
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.base / 'bin').resolve(), version)

        install_prepared_version()
        self.assertEqual(live.read_text(), THREADS.read_text())
        self.assertEqual(live.stat().st_mode & 0o777, 0o600)
        rotated = live.read_text().replace(THREAD, '00000000-0000-4000-8000-000000000007')
        live.write_text(rotated)
        git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'next version')
        install_prepared_version()
        self.assertEqual(live.read_text(), rotated)


if __name__ == '__main__':
    unittest.main()
