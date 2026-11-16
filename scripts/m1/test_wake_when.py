import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


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

    def invoke(self, source, label='CI check', thread=THREAD, timeout='5s', extra_env=None):
        timeout_args = ['--timeout', timeout] if timeout else []
        return subprocess.run([sys.executable, str(TOOL), '--thread', thread, '--label', label,
                               *timeout_args, '--', sys.executable, '-c', source],
                              env=dict(self.env, **(extra_env or {})), cwd=self.home,
                              capture_output=True, text=True, timeout=12)

    def start(self, source, **kwargs):
        result = self.invoke(source, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        item = json.loads(result.stdout)
        self.started.append(item)
        return item

    def finished(self, item):
        deadline = time.monotonic() + 12
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
        self.assertIn('CI check 结束：成功（退出码 0）', args[4])
        self.assertNotIn('最后 30 行', args[4])
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn(str(self.home), Path(item['log']).read_text())
        self.assertIn('$(false); keep literal', Path(item['log']).read_text())
        self.assertEqual(Path(item['log']).stat().st_mode & 0o777, 0o600)
        self.assert_released(item)

    def test_failure_notifies_exit_code_and_only_last_30_lines(self):
        item = self.start('import sys; [print("L"+str(i)) for i in range(40)]; sys.exit(7)')
        state = self.finished(item)
        self.assertEqual((state['outcome'], state['commandExitCode']), ('失败', 7))
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
        self.assertEqual((state['outcome'], state['commandExitCode']), ('超时', 124))
        self.assertIn('超时（退出码 124）', self.notifications()[0][4])
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

    def test_stale_unlocked_file_is_removed_on_next_launch(self):
        directory = self.base / 'qa/wake-when/.locks'
        directory.mkdir(parents=True)
        stale = directory / 'old.lock'
        stale.write_text('reboot left a file, not a held lock')
        item = self.start('pass')
        self.finished(item)
        self.assertFalse(stale.exists())
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
