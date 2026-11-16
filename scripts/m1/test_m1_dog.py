"""Isolated destructive drills: no live Codex queue, Telegram, launchd or deploy."""
from datetime import datetime, timezone
import json
import fcntl
import plistlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import wake_runtime as runtime

HERE = Path(__file__).parent
THREAD = '01a1d8ae-d108-7a11-8d08-f54bc8f90df6'


class Dog(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.env = patch.dict(os.environ, HOME=str(self.home))
        self.env.start()
        self.addCleanup(self.env.stop)
        runtime.base().mkdir()
        (runtime.base() / 'wake-when.threads').write_text((HERE / 'wake-when.threads').read_text())
        self.sessions = self.home / '.codex/sessions'
        self.sessions.mkdir(parents=True)
        for thread in runtime.threads():
            (self.sessions / ('rollout-' + thread + '.jsonl')).write_text('{}\n')
        self.dog = runtime.load_tool('m1-dog')
        self.wake = runtime.load_tool('wake-when')
        self.queue = self.home / '.local/bin/codex'
        self.queue.parent.mkdir(parents=True)
        self.queue.write_text('#!' + sys.executable + '''
import json,sys,os
from pathlib import Path
p=Path.home()/'queue.jsonl'
with p.open('a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
mode=Path.home()/'queue-mode'
if mode.exists():
 value=mode.read_text()
 if value=='archived': print('thread is archived'); sys.exit(9)
 if value=='fail': sys.exit(9)
 if value=='once': mode.unlink(); sys.exit(9)
''')
        self.queue.chmod(0o755)
        self.messages = []
        def tg(message):
            self.messages.append(message)
            return True
        self.telegram = patch.object(runtime, 'telegram', side_effect=tg)
        self.telegram.start()
        self.addCleanup(self.telegram.stop)
        self.delay = patch.object(runtime, 'QUEUE_DELAYS', (0, 0, 0))
        self.delay.start()
        self.addCleanup(self.delay.stop)
        self.now = time.time()
        self.boot = runtime.boot_id()
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for pid in self.children:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass

    def notifications(self):
        p = self.home / 'queue.jsonl'
        return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []

    def task(self, **kwargs):
        run = runtime.root() / 'fixture'
        state = dict(label='fixture CI', thread=THREAD, startedAt=runtime.stamp(), timeoutSeconds=3600,
                     pid=99999999, boot=self.boot, identity='missing', notification='waiting')
        state.update(kwargs)
        runtime.save(run / 'result.json', state)
        return run, state

    def turn(self, at, text, started=False, turn_id='turn1', thread=THREAD):
        path = self.sessions / ('rollout-' + thread + '.jsonl')
        rows = [dict(timestamp=datetime.fromtimestamp(at, timezone.utc).isoformat(), type='event_msg',
                     payload=dict(type='task_complete', turn_id=turn_id, last_agent_message=text))]
        if started:
            rows.append(dict(type='event_msg', payload=dict(type='task_started')))
        path.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\n')

    def test_killed_real_supervisor_detected_once_without_stopping_command(self):
        result = subprocess.run([sys.executable, str(HERE / 'wake-when'), '--thread', THREAD,
                                 '--label', 'killed smoke', '--timeout', '60s', '--', sys.executable,
                                 '-c', 'import time; time.sleep(60)'], capture_output=True, text=True, check=True)
        item = json.loads(result.stdout)
        self.children.append(item['pid'])
        run = Path(item['result']).parent
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            beat = runtime.read(run / 'heartbeat.json', {})
            if beat.get('commandPid'): break
            time.sleep(.02)
        self.assertTrue(beat.get('commandPid'))
        self.children.append(beat['commandPid'])
        os.kill(item['pid'], signal.SIGKILL)
        deadline = time.monotonic() + 5
        while runtime.process_identity(item['pid']) and time.monotonic() < deadline: time.sleep(.02)
        self.dog.check_round()
        self.dog.check_round()
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('等待中断，请自行核对 killed smoke', self.notifications()[0][4])
        self.assertTrue(runtime.process_identity(beat['commandPid']), 'dog must not stop somebody else’s work')
        self.assertEqual(list((runtime.root() / '.locks').glob('*.lock')), [])

    def test_reboot_and_pid_reuse_do_not_hide_unfinished_wait(self):
        run, state = self.task(pid=os.getpid(), identity=runtime.process_identity(os.getpid()), boot='old boot')
        self.dog.check_round()
        self.assertIn('M1 重启', self.notifications()[0][4])
        self.dog.check_round()
        self.assertEqual(len(self.notifications()), 1)
        self.assertEqual(runtime.read(run / 'result.json'), state, 'do not forge task completion')

    def test_stale_heartbeat_alerts_but_long_live_silent_command_does_not(self):
        run, state = self.task(pid=os.getpid(), identity=runtime.process_identity(os.getpid()))
        runtime.save(run / 'heartbeat.json', dict(at=datetime.fromtimestamp(self.now-181, timezone.utc).isoformat()))
        self.dog.check_round(self.now)
        self.assertIn('心跳', self.notifications()[0][4])
        runtime.save(run / 'heartbeat.json', dict(at=runtime.stamp()))
        self.assertEqual(self.dog.task_active(state, run, self.boot, time.time()), (True, None))

    def test_queue_retries_success_and_exhaustion_escalates_tg_without_rerun(self):
        directory = runtime.incident('retry')
        (self.home / 'queue-mode').write_text('once')
        result = runtime.deliver(directory, THREAD, 'finished', self.wake.run_group)
        self.assertEqual((result['status'], result['attempts']), ('sent', 2))
        self.assertEqual(self.messages, [])
        (self.home / 'queue-mode').write_text('fail')
        directory = runtime.incident('failed')
        result = runtime.deliver(directory, THREAD, 'finished', self.wake.run_group)
        self.assertEqual((result['status'], result['attempts']), ('escalated', 4))
        self.assertEqual(len(self.messages), 1)
        runtime.deliver(directory, THREAD, 'finished', self.wake.run_group)
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(len(self.notifications()), 6)

    def test_timeout_queue_cleans_process_and_escalates(self):
        self.queue.write_text('#!' + sys.executable + '\nimport time; time.sleep(60)\n')
        def bounded(argv, _timeout, log):
            return self.wake.run_group(argv, .05, log)
        result = runtime.deliver(runtime.incident('timeout'), THREAD, 'finished', bounded)
        self.assertTrue(result['queueTimedOut'])
        self.assertEqual(result['attempts'], 4)
        self.assertEqual(len(self.messages), 1)

    def test_archived_and_missing_thread_go_immediately_to_tg(self):
        archived = self.home / '.codex/archived_sessions'
        archived.mkdir()
        source = self.sessions / ('rollout-' + THREAD + '.jsonl')
        source.rename(archived / source.name)
        result = runtime.deliver(runtime.incident('archive'), THREAD, 'notice', self.wake.run_group)
        self.assertEqual(result['status'], 'escalated')
        self.assertEqual(self.notifications(), [])
        self.assertIn('归档', self.messages[0])
        (archived / source.name).unlink()
        runtime.deliver(runtime.incident('missing'), THREAD, 'notice', self.wake.run_group)
        self.assertIn('不存在', self.messages[1])

    def test_queue_archived_rejection_is_immediate_even_with_local_rollout(self):
        (self.home / 'queue-mode').write_text('archived')
        result = runtime.deliver(runtime.incident('archive'), THREAD, 'notice', self.wake.run_group)
        self.assertEqual(result['attempts'], 1)
        self.assertEqual(len(self.messages), 1)

    def test_empty_wait_is_per_finished_turn_and_no_active_work(self):
        self.turn(self.now-1801, '本线正在等待 CI run 43921068131 结束。')
        self.dog.check_round(self.now)
        self.dog.check_round(self.now+600)
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('空等提醒', self.notifications()[0][4])
        self.turn(self.now-1801, '本线正在等待 CI run 43921068131 结束。', started=True)
        self.assertIsNone(self.dog.last_turn(self.sessions / ('rollout-' + THREAD + '.jsonl')))

    def test_active_wait_recent_delivery_and_non_wait_text_do_not_page(self):
        self.turn(self.now-1801, '本线正在等待 M5 批次 20261116-123456-51f0a066 结束。')
        run, state = self.task(pid=os.getpid(), identity=runtime.process_identity(os.getpid()))
        self.dog.check_round(self.now)
        self.assertEqual(self.notifications(), [])
        state.update(notification='sent', finishedAt=runtime.stamp())
        runtime.save(run / 'result.json', state)
        self.dog.check_round(self.now)
        self.assertEqual(self.notifications(), [])
        self.assertFalse(self.dog.says_waiting('CI 已通过，不再等待。'))
        self.assertFalse(self.dog.says_waiting('等待用户审批。CI 已通过。'))
        self.assertFalse(self.dog.says_waiting('等待用户批准，CI已通过'))
        self.assertFalse(self.dog.says_waiting('仍在等待新头CI结束'))
        self.assertTrue(self.dog.says_waiting('仍在等待新头 CI run 43921068131 结束'))

    def test_rule_acknowledgements_examples_and_finished_work_never_page(self):
        messages = [
            '收到。以后 CI 等待统一加 `gh run watch … --exit-status --interval 60`；正在等待的不重挂。\n\n资源已释放：无。',
            '收到，以后正在等待 CI run 43921068131 时统一加 --interval 60。',
            '规则确认：例如本线正在等待 CI run 43921068131。',
            '确认模板：本线正在等待 CI run 43921068131。',
            '本线并非正在等待 CI run 43921068131。',
            '本线不需要等待 CI run 43921068131。',
            '本线并未等待 CI run 43921068131。',
            '当前打野线正在等待 CI run 43921068131。',
            '当前日志原文是“本线正在等待 CI run 43921068131”，这是旧回合记录。',
            '本线转述打野线的状态：正在等待 CI run 43921068131。',
            '模型线正在等待 CI run 43921068131；本线方案已交付。',
            '打野正在等待 M5 批次 batch-a。',
            '本线无待挂等待任务。正在等待 CI run 43921068131 是示例。',
            'MET-257 只读方案已交付，本线没有执行中任务。',
            '方案已交付；后续正在等待 M5 批次 20261116-123456 时按规则处理。',
            '当前没有等待任务。以下是旧回执：正在等待 CI run 43921068131。',
            '> 本线正在等待 CI run 43921068131\n已确认规则。',
            '```text\n本线正在等待 CI run 43921068131\n```\n用法已确认。',
            '正在等待 #889 CI 结束。',
            '正在等待 M5 结束。',
            '正在等待部署。',
            'CI run 43921068131 已通过，不再等待。',
            '仍在等待 CI run 43921068131。CI run 43921068131 已结束。',
            '仍在等待 M5 批次 batch-a。M5 批次 batch-a 已完成。',
            '仍在等待部署 67251a4c。部署 67251a4c 终态 success。',
            '本线正在等待 CI run 43921068131。CI run 43921068131 已失败。',
            '本线正在等待 CI run 43921068131。CI run 43921068131 已超时。',
        ]
        for index, message in enumerate(messages):
            with self.subTest(message=message):
                self.assertFalse(self.dog.says_waiting(message))
                self.turn(self.now-1801, message, turn_id='negative-%s' % index)
                self.dog.check_round(self.now)
                self.assertEqual(self.notifications(), [])

    def test_all_native_ci_conclusions_suppress_only_the_matching_run(self):
        for index, conclusion in enumerate(sorted(self.wake.CI_CONCLUSIONS)):
            with self.subTest(conclusion=conclusion):
                pending = '本线正在等待 CI run 43921068131。'
                settled = 'CI run 43921068131 终态：`%s`。' % conclusion
                self.assertFalse(self.dog.says_waiting(pending + settled))
                self.assertTrue(self.dog.says_waiting(pending + settled.replace('43921068131', '43915598967')))
                self.turn(self.now-1801, pending + settled, turn_id='conclusion-%s' % index)
                self.dog.check_round(self.now)
                self.assertEqual(self.notifications(), [])

    def test_explicit_running_tasks_page_and_new_input_cancels_detection(self):
        for index, message in enumerate([
            '本线正在等待 CI run 43921068131 结束。',
            '仍在等待 https://github.com/semiok/allrice/actions/runs/43921068131 的结果。',
            '已启动 M5 批次 20261116-123456-51f0a066，正在等待结果。',
            '当前正在等待部署 67251a4c 的 ready 结果。',
            '本线正在等待部署任务 release-123 的结果。',
            'Astra 已通过；仍在等待 CI run 43921068131 结束。',
        ]):
            with self.subTest(message=message):
                self.assertTrue(self.dog.says_waiting(message))
        self.turn(self.now-1801, message)
        path = self.sessions / ('rollout-' + THREAD + '.jsonl')
        with path.open('a') as f:
            f.write(json.dumps(dict(type='response_item', payload=dict(role='user'))) + '\n')
        self.dog.check_round(self.now)
        self.assertEqual(self.notifications(), [])

    def check_at(self, now):
        with patch.object(runtime, 'stamp', return_value=datetime.fromtimestamp(now, timezone.utc).isoformat()):
            self.dog.check_round(now)

    def test_empty_wait_rolling_24h_survives_new_turn_restart_and_midnight(self):
        now = datetime(2026, 11, 16, 23, 40, tzinfo=timezone.utc).timestamp()
        text = '本线正在等待 CI run 43921068131。'
        self.turn(now-1801, text)
        self.check_at(now)
        self.assertEqual(len(self.notifications()), 1)
        self.turn(now+600, text, turn_id='turn2')
        self.dog = runtime.load_tool('m1-dog')  # no in-memory cooldown after restart
        self.check_at(now+2401)  # crossed UTC midnight, still within rolling 24h
        self.check_at(now+86399)
        self.assertEqual(len(self.notifications()), 1)
        self.check_at(now+86400)
        self.assertEqual(len(self.notifications()), 2)
        self.turn(now+86401, text, turn_id='turn3')
        self.check_at(now+90000)
        self.assertEqual(len(self.notifications()), 2)

    def test_empty_wait_legacy_delivery_cooldown_is_thread_scoped(self):
        old = runtime.incident('old-version-empty')
        runtime.save(old / 'delivery.json', dict(thread=THREAD, message='M1-dog 空等提醒：旧版提醒',
                     sentAt=datetime.fromtimestamp(self.now-600, timezone.utc).isoformat()))
        text = '本线正在等待 CI run 43921068131。'
        self.turn(self.now-1801, text)
        other = next(thread for thread in runtime.threads() if thread != THREAD)
        self.turn(self.now-1801, text, thread=other)
        self.check_at(self.now)
        notices = self.notifications()
        self.assertEqual(len(notices), 1)
        self.assertEqual(notices[0][2], other)

    def test_empty_wait_queue_failure_does_not_start_another_incident_next_turn(self):
        (self.home / 'queue-mode').write_text('fail')
        text = '本线正在等待 CI run 43921068131。'
        self.turn(self.now-1801, text)
        self.check_at(self.now)
        self.assertEqual(len(self.notifications()), 4)
        self.turn(self.now-1801, text, turn_id='new-turn')
        self.check_at(self.now+600)
        self.assertEqual(len(self.notifications()), 4)

    def test_failed_tg_persists_backoff_and_daily_is_once_per_day(self):
        directory = runtime.incident('tgfail')
        with patch.object(runtime, 'telegram', return_value=False) as send:
            self.assertTrue(runtime.alert(directory, 'test', self.now)['unresolved'])
            runtime.alert(directory, 'test', self.now+1)
            self.assertEqual(send.call_count, 1)
        runtime.alert(directory, 'test', self.now+1000)
        self.assertFalse(runtime.read(directory / 'telegram.json')['unresolved'])
        now = datetime(2026, 11, 16, 1, tzinfo=timezone.utc).timestamp()
        self.dog.check_round(now)
        self.dog.check_round(now+600)
        self.assertEqual(sum('平安报告' in s for s in self.messages), 1)

    def test_daily_counts_rate_limit_episodes_across_tasks_without_double_count(self):
        for task, number, day in [('a', 1, '16'), ('a', 2, '16'), ('b', 1, '16'), ('b', 2, '15')]:
            runtime.save(runtime.root() / task / ('github-rate-limit-%s.json' % number),
                         dict(at='2026-11-%sT00:01:00+00:00' % day))
        now = datetime(2026, 11, 16, 1, tzinfo=timezone.utc).timestamp()
        self.dog.check_round(now)
        self.dog.check_round(now+600)
        reports = [s for s in self.messages if '平安报告' in s]
        self.assertEqual(len(reports), 1)
        self.assertIn('当日 GitHub 限流次数 3', reports[0])
        self.assertEqual(runtime.read(runtime.root() / 'dog/state.json')['githubRateLimitCount'], 3)

    def test_deploy_terminal_after_cleanup_and_original_exit_is_preserved(self):
        receipt = self.home / 'terminal.json'
        subprocess.run([sys.executable, str(HERE / 'deploy-result.py'), 'start', str(receipt), 'deploy1'], check=True)
        # Source actual on_exit; stub only recovery/cleanup services. No Dev calls.
        command = 'source "$1"; RESULT_FILE="$2"; RESULT_ID=deploy1; release_lock() { echo cleaned > "$HOME/cleaned"; }; on_exit 5'
        proc = subprocess.run(['/bin/bash', '-c', command, 'sh', str(HERE / 'deploy-dev'), str(receipt)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertTrue((self.home / 'cleaned').exists())
        data = json.loads(receipt.read_text())
        self.assertEqual((data['id'], data['status'], data['exitCode']), ('deploy1', 'completed', 5))
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        refused = subprocess.run([sys.executable, str(HERE / 'deploy-result.py'), 'start', str(receipt), 'other'], capture_output=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(json.loads(receipt.read_text()), data)

    def test_launchd_install_backs_up_validates_and_rolls_back_failed_activation(self):
        path = self.home / 'Library/LaunchAgents' / (self.dog.LABEL + '.plist')
        path.parent.mkdir(parents=True)
        original = plistlib.dumps(dict(Label=self.dog.LABEL, ProgramArguments=['old-dog']))
        path.write_bytes(original)
        calls = []
        bootstraps = []
        def command(argv, **kwargs):
            calls.append(argv)
            if argv[:2] == ['launchctl', 'print']:
                # Initially loaded; bootout then immediately absent.
                code = 0 if len(calls) == 1 else 113
                return subprocess.CompletedProcess(argv, code, b'old service', b'')
            if argv[:2] == ['launchctl', 'bootstrap']:
                bootstraps.append(path.read_bytes())
                if len(bootstraps) == 1:
                    raise subprocess.CalledProcessError(5, argv)
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        with patch.object(self.dog.sys, 'platform', 'darwin'), patch.object(self.dog.subprocess, 'run', side_effect=command):
            with self.assertRaises(subprocess.CalledProcessError):
                self.dog.launchd('install')
        candidate = plistlib.loads(bootstraps[0])
        self.assertTrue(candidate['RunAtLoad'])
        self.assertTrue(candidate['KeepAlive'])
        self.assertEqual(candidate['ThrottleInterval'], 60)
        self.assertEqual(bootstraps[1], original)
        self.assertEqual(path.read_bytes(), original)
        backup = list((runtime.root() / 'dog/launchd-backups').glob('*/before.json'))
        self.assertEqual(len(backup), 1)
        self.assertTrue(json.loads(backup[0].read_text())['loaded'])
        self.assertTrue(any(c[0] == 'plutil' for c in calls))

    def test_delivery_lock_prevents_two_concurrent_queue_senders(self):
        import concurrent.futures
        directory = runtime.incident('concurrent')
        def sender():
            return runtime.deliver(directory, THREAD, 'one message', self.wake.run_group)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: sender(), range(2)))
        self.assertTrue(any(r.get('sentAt') for r in results))
        self.assertEqual(len(self.notifications()), 1)


    def test_old_interruption_does_not_hide_new_empty_wait(self):
        run, state = self.task()
        incident = runtime.incident('interrupted:' + str(run))
        runtime.save(incident / 'delivery.json', dict(status='sent', sentAt=datetime.fromtimestamp(self.now-3600, timezone.utc).isoformat()))
        self.turn(self.now-1801, '正在等待 CI run 43921068131 结束')
        self.dog.check_round(self.now)
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('空等提醒', self.notifications()[0][4])
        self.dog.check_round(self.now+600)
        self.assertEqual(len(self.notifications()), 1)

    def test_normal_wait_escalation_survives_next_day_and_can_be_acknowledged(self):
        run, state = self.task(commandEndedAt=runtime.stamp(), task=dict(status='completed', conclusion='success'))
        (self.home / 'queue-mode').write_text('fail')
        self.dog.check_round(self.now)
        snapshot = runtime.read(runtime.root() / 'dog/state.json')
        self.assertEqual(snapshot['escalated'], 1)
        self.assertEqual(snapshot['pendingAlerts'], ['fixture'])
        self.assertTrue(runtime.read(run / 'telegram.json').get('sentAt'))
        self.dog.check_round(self.now + 86400)
        self.assertEqual(runtime.read(runtime.root() / 'dog/state.json')['escalated'], 1)
        self.dog.acknowledge('fixture')
        self.dog.check_round(self.now + 86401)
        self.assertEqual(runtime.read(runtime.root() / 'dog/state.json')['escalated'], 0)
        with self.assertRaises(ValueError): self.dog.acknowledge('../outside')

    def test_yesterday_daily_backlog_retries_after_midnight(self):
        now = datetime(2026, 11, 17, 1, tzinfo=timezone.utc).timestamp()
        yesterday = runtime.root() / 'dog/daily/2026-11-16'
        runtime.save(yesterday / 'telegram.json', dict(message='yesterday report', unresolved=True, retryAt=now-1))
        self.dog.check_round(now)
        self.assertIn('yesterday report', self.messages)
        self.assertTrue(runtime.read(yesterday / 'telegram.json').get('sentAt'))
        self.dog.check_round(now+600)
        self.assertEqual(self.messages.count('yesterday report'), 1)

    def test_bad_heartbeat_and_rollout_do_not_stop_other_threads_or_daily(self):
        run, _ = self.task(pid=os.getpid(), identity=runtime.process_identity(os.getpid()))
        runtime.save(run / 'heartbeat.json', dict(at='not-a-timestamp'))
        self.dog.check_round(self.now)
        self.assertTrue(any('记录损坏' in m for m in self.messages))
        self.assertTrue(runtime.read(runtime.root() / 'dog/heartbeat.json').get('completedAt'))
        self.turn(self.now-1801, '正在等待 CI run 43921068131 结束')
        path = self.sessions / ('rollout-' + THREAD + '.jsonl')
        row = json.loads(path.read_text()); row['timestamp'] = 'invalid'
        path.write_text(json.dumps(row) + '\n')
        self.dog.check_round(self.now)
        self.assertTrue(any('回合记录无法解析' in m for m in self.messages))

    def test_deploy_cleanup_failure_and_signal_write_actual_terminal_exit(self):
        for cleanup, expected in [('return 23', 23), ('kill -TERM $$', 130)]:
            with self.subTest(cleanup=cleanup):
                receipt = self.home / ('cleanup-%s.json' % expected)
                subprocess.run([sys.executable, str(HERE / 'deploy-result.py'), 'start', str(receipt), 'deploy1'], check=True)
                command = ('source "$1"; RESULT_FILE="$2"; RESULT_ID=deploy1; '
                           'release_lock() { ' + cleanup + '; }; exit 5')
                proc = subprocess.run(['/bin/bash', '-c', command, 'sh', str(HERE / 'deploy-dev'), str(receipt)], capture_output=True, text=True)
                self.assertEqual(proc.returncode, expected, proc.stderr)
                data = json.loads(receipt.read_text())
                self.assertEqual((data['status'], data['exitCode'], data['initialExitCode']), ('completed', expected, 5))

    def test_launchd_probe_failure_after_bootout_restores_old_service(self):
        path = self.home / 'Library/LaunchAgents' / (self.dog.LABEL + '.plist')
        path.parent.mkdir(parents=True)
        original = plistlib.dumps(dict(Label=self.dog.LABEL, ProgramArguments=['old-dog']))
        path.write_bytes(original)
        state = dict(loaded=True, probed=False, restored=False)
        def command(argv, **kwargs):
            if argv[:2] == ['launchctl', 'print']:
                if not state['loaded'] and not state['probed']:
                    state['probed'] = True
                    raise subprocess.TimeoutExpired(argv, 5)
                return subprocess.CompletedProcess(argv, 0 if state['loaded'] else 113, b'old service', b'')
            if argv[:2] == ['launchctl', 'bootout']:
                state['loaded'] = False
            if argv[:2] == ['launchctl', 'bootstrap']:
                self.assertEqual(path.read_bytes(), original)
                state.update(loaded=True, restored=True)
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        with patch.object(self.dog.sys, 'platform', 'darwin'), patch.object(self.dog.subprocess, 'run', side_effect=command):
            with self.assertRaises(subprocess.TimeoutExpired): self.dog.launchd('install')
        self.assertTrue(state['restored'])
        self.assertTrue(state['loaded'])
        self.assertEqual(path.read_bytes(), original)


    def test_stalled_notification_owner_alerts_once_without_breaking_delivery_lock(self):
        run, state = self.task(pid=os.getpid(), identity=runtime.process_identity(os.getpid()),
                               commandEndedAt=runtime.stamp(), task=dict(status='completed', conclusion='success'))
        runtime.save(run / 'delivery.json', dict(status='sending', attempts=1))
        fd = os.open(run / 'delivery.lock', os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runtime.save(run / 'heartbeat.json', dict(at=runtime.stamp()))
        self.dog.check_round(self.now)
        self.assertEqual(self.notifications(), [], 'a live sender must finish undisturbed')
        runtime.save(run / 'heartbeat.json', dict(at=datetime.fromtimestamp(self.now-600, timezone.utc).isoformat()))
        self.dog.check_round(self.now)
        self.dog.check_round(self.now+600)
        self.assertEqual(len(self.notifications()), 1)
        self.assertIn('通知投递卡住', self.notifications()[0][4])
        self.assertEqual(runtime.read(run / 'result.json'), state)
        probe = os.open(run / 'delivery.lock', os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError): fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(probe)
        self.assertTrue(runtime.process_identity(os.getpid()))



if __name__ == '__main__':
    unittest.main()
