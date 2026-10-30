# Unit tests for scripts/m1/monitor (MET-222): the alert state machine, message
# composition, delivery backlog and the checks' judgement, with every system call stubbed.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import importlib.machinery
import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader('monitor', os.path.join(HERE, 'monitor'))
_spec = importlib.util.spec_from_loader('monitor', _loader)
monitor = importlib.util.module_from_spec(_spec)
_loader.exec_module(monitor)


def make_round(peer=False, **overrides):
    tmp = tempfile.mkdtemp(prefix='monitor-test-')
    cfg = json.loads(json.dumps(monitor.PEER if peer else monitor.M1))
    cfg.update(stateDir=tmp, telegramEnv=os.path.join(tmp, 'telegram.env'), confirmSeconds=0, configFile=None, **overrides)
    cfg.update(webLabel='web', workerLabel='worker', databaseUrl='postgres://x', incidentDatabaseUrl='postgres://x',
               workerUrl='http://127.0.0.1:1', webUrl='http://127.0.0.1:2')
    return monitor.Round(cfg, peer)


def bad(key, sev='critical', title='坏了', detail='d'):
    return monitor.finding(key, sev, title, detail, 'x.md', 'step')


def ok(key):
    return monitor.finding(key, 'ok', '坏了')


def step(r, findings, at, ran=()):
    r.now = at
    return [(e['event'], e['finding']['key'], e['silent']) for e in monitor.evaluate(r, findings, ran)]


class AlertStateMachine(unittest.TestCase):
    def test_open_quiet_remind_escalate_recover(self):
        r = make_round()
        self.assertEqual(step(r, [bad('vm', 'warning')], 0), [('opened', 'vm', False)])
        self.assertEqual(step(r, [bad('vm', 'warning')], 300), [])
        self.assertEqual(step(r, [bad('vm', 'critical')], 600), [('escalated', 'vm', False)])
        self.assertEqual(step(r, [bad('vm', 'critical')], 600 + 3599), [])
        self.assertEqual(step(r, [bad('vm', 'critical')], 600 + 3600), [('reminder', 'vm', False)])
        self.assertEqual(step(r, [ok('vm')], 5000), [('recovered', 'vm', False)])
        self.assertEqual(r.state['alerts'], {})
        rows = r.state['incidentOutbox']
        self.assertEqual([(x['kind'], x['metadata']['event']) for x in rows],
                         [('monitor_alert', 'opened'), ('monitor_alert', 'escalated'), ('monitor_alert', 'reminder'), ('monitor_recovered', 'recovered')])
        self.assertEqual(rows[0]['id'], rows[3]['metadata']['alertId'])  # recovery points at its alert
        self.assertEqual(rows[3]['metadata']['durationSeconds'], 5000)

    def test_no_re_escalation_while_hovering_at_a_threshold(self):
        r = make_round()
        step(r, [bad('q', 'warning')], 0)
        self.assertEqual(step(r, [bad('q', 'critical')], 300), [('escalated', 'q', False)])
        seen = []
        for i in range(4):  # back and forth across the critical line
            seen += step(r, [bad('q', 'warning')], 600 + i * 600)
            seen += step(r, [bad('q', 'critical')], 900 + i * 600)
        self.assertEqual(seen, [])

    def test_an_outage_breaks_a_flapping_mute(self):
        r = make_round()
        for i in range(3):
            step(r, [bad('t')], i * 600)
            step(r, [ok('t')], i * 600 + 300)
        self.assertEqual(step(r, [bad('t')], 1800), [('opened', 't', True)])
        self.assertEqual(step(r, [bad('t')], 1800 + 239), [('reminder', 't', False)])  # still bad on the next round, even a second early: paged
        self.assertEqual(step(r, [ok('t')], 2400), [('recovered', 't', False)])

    def test_escalation_inside_a_mute_ends_it(self):
        r = make_round()
        for i in range(3):
            step(r, [bad('t', 'warning')], i * 600)
            step(r, [ok('t')], i * 600 + 300)
        self.assertEqual(step(r, [bad('t', 'warning')], 1800), [('opened', 't', True)])
        self.assertEqual(step(r, [bad('t', 'critical')], 1830), [('escalated', 't', False)])
        self.assertEqual(step(r, [bad('t', 'critical')], 2100), [])  # no early reminder after the escalation
        self.assertEqual(step(r, [ok('t')], 2400), [('recovered', 't', False)])  # and its recovery is told

    def test_unknown_neither_opens_nor_closes(self):
        r = make_round()
        self.assertEqual(step(r, [monitor.unknown('v')], 0), [])
        step(r, [bad('vm:a')], 0, {'vm'})
        self.assertEqual(step(r, [monitor.unknown('vm:a')], 300, {'vm'}), [])  # not "removed from the config"
        self.assertIn('vm:a', r.state['alerts'])

    def test_flapping_is_muted_after_one_notice(self):
        r = make_round()
        seen = []
        for i in range(4):
            seen += step(r, [bad('t')], i * 600)
            seen += step(r, [ok('t')], i * 600 + 300)
        self.assertEqual(seen[:4], [('opened', 't', False), ('recovered', 't', False), ('opened', 't', False), ('recovered', 't', False)])
        self.assertEqual(seen[4], ('flapping', 't', False))
        self.assertTrue(all(silent for _, _, silent in seen[5:]))
        # after the mute window a new failure pages again
        self.assertEqual(step(r, [bad('t')], 3 * 600 + 300 + 3601), [('opened', 't', False)])

    def test_recovery_hidden_by_a_mute_is_sent_when_it_ends(self):
        r = make_round()
        for i in range(3):
            step(r, [bad('t')], i * 600)
            step(r, [ok('t')], i * 600 + 300)  # third recovery falls into the mute: silent
        self.assertEqual(step(r, [ok('t')], 1800), [])
        self.assertEqual(step(r, [ok('t')], 1200 + 3601), [('recovered', 't', False)])  # told once the mute ends
        self.assertEqual(step(r, [ok('t')], 1200 + 3900), [])

    def test_opened_during_a_mute_is_told_when_it_ends(self):
        r = make_round()
        for i in range(3):
            step(r, [bad('t')], i * 600)
            step(r, [ok('t')], i * 600 + 300)
        self.assertEqual(step(r, [bad('t')], 1800), [('opened', 't', True)])
        self.assertEqual(step(r, [bad('t')], 1200 + 3601), [('reminder', 't', False)])

    def test_per_item_alert_recovers_when_item_leaves_the_config(self):
        r = make_round()
        step(r, [bad('disk:/Volumes/x')], 0, {'disk'})
        self.assertEqual(step(r, [ok('disk:~')], 300, {'images'}), [])  # disk did not run: unknown
        self.assertEqual(step(r, [ok('disk:~')], 600, {'disk'}), [('recovered', 'disk:/Volumes/x', False)])

    def test_incidents_off_writes_nothing(self):
        r = make_round(incidents=False)
        step(r, [bad('a')], 0)
        self.assertNotIn('incidentOutbox', r.state)


class Messages(unittest.TestCase):
    def test_one_message_per_round(self):
        r = make_round(label='演练')
        step(r, [bad('old')], 0)
        r.now = 900
        events = monitor.evaluate(r, [ok('old'), bad('new', 'warning', '磁盘余量不足', '剩 3 GiB')])
        texts = monitor.compose(r, events)
        self.assertEqual(len(texts), 1)
        text = texts[0]
        self.assertTrue(text.startswith('🟠 [演练] AllRice M1 Dev：1 项告警，1 项恢复'))
        self.assertIn('[警告] 磁盘余量不足', text)
        self.assertIn('   第一步：step', text)
        self.assertIn('手册：https://github.com/semiok/allrice/blob/main/docs/runbooks/x.md', text)
        self.assertIn('✅ 已恢复：坏了（持续 15 分钟）', text)

    def test_nothing_to_say(self):
        r = make_round()
        self.assertEqual(monitor.compose(r, []), [])

    def test_a_long_round_is_split_between_alerts(self):
        r = make_round()
        r.now = 0
        events = monitor.evaluate(r, [bad('k%d' % i, 'critical', '告警%d' % i, '很长的详情' * 120) for i in range(12)])
        texts = monitor.compose(r, events)
        self.assertGreater(len(texts), 1)
        self.assertTrue(all(len(t) <= monitor.MESSAGE_LIMIT + 200 for t in texts))
        self.assertTrue(texts[0].startswith('🔴 AllRice M1 Dev：12 项告警（1/%d）' % len(texts)))
        joined = '\n'.join(texts)
        self.assertTrue(all('告警%d' % i in joined for i in range(12)))  # nothing cut off


class Delivery(unittest.TestCase):
    def test_backlog_survives_failures_and_hides_the_token(self):
        r = make_round()
        with open(r.cfg['telegramEnv'], 'w') as f:
            f.write('TELEGRAM_BOT_TOKEN=123:secret\nTELEGRAM_CHAT_ID=42\n')
        sent = []

        def refuse(url, data=None, timeout=None):
            raise monitor.urllib.error.URLError('cannot reach https://api.telegram.org/bot123:secret/sendMessage')

        with mock.patch.object(monitor, 'opener', return_value=mock.Mock(open=refuse)):
            self.assertFalse(monitor.deliver(r, 'a'))
            self.assertFalse(monitor.deliver(r, 'b'))
        self.assertEqual(r.state['outbox'], ['a', 'b'])
        self.assertNotIn('secret', r.state['telegram']['lastError']['error'])
        self.assertIn('failingSince', r.state['telegram'])
        with mock.patch.object(monitor, 'send_telegram', side_effect=lambda cfg, text: sent.append(text)):
            self.assertTrue(monitor.deliver(r, 'c'))
        self.assertEqual(sent, ['a', 'b', 'c'])
        self.assertEqual(r.state['outbox'], [])
        self.assertNotIn('failingSince', r.state['telegram'])

    def test_retry_direct_when_the_proxy_is_dead(self):
        r = make_round()
        with open(r.cfg['telegramEnv'], 'w') as f:
            f.write('TELEGRAM_BOT_TOKEN=1:t\nTELEGRAM_CHAT_ID=2\n')
        routes = []

        def via(proxy):
            routes.append(proxy)
            if proxy is None:
                return mock.Mock(open=mock.Mock(side_effect=monitor.urllib.error.URLError('proxy refused')))
            resp = mock.MagicMock()
            resp.__enter__.return_value = io.BytesIO(b'{"ok": true}')
            return mock.Mock(open=mock.Mock(return_value=resp))

        with mock.patch.object(monitor, 'opener', side_effect=via):
            monitor.send_telegram(r.cfg, 'hi')
        self.assertEqual(routes, [None, ''])

    def test_every_message_carries_the_prefix(self):
        r = make_round()
        with open(r.cfg['telegramEnv'], 'w') as f:
            f.write('TELEGRAM_BOT_TOKEN=1:t\nTELEGRAM_CHAT_ID=2\n')
        sent = []

        def via(proxy):
            resp = mock.MagicMock()
            resp.__enter__.return_value = io.BytesIO(b'{"ok": true}')
            return mock.Mock(open=lambda url, data, timeout: sent.append(monitor.urllib.parse.parse_qs(data.decode())) or resp)

        with mock.patch.object(monitor, 'opener', side_effect=via):
            monitor.send_telegram(r.cfg, '🔴 M1：1 项告警')
        self.assertEqual(sent[0]['text'], ['【AllRice 告警】🔴 M1：1 项告警'])

    def test_psql_keeps_the_password_off_the_command_line(self):
        r = make_round()
        with mock.patch.object(monitor, 'run', return_value=(0, '1', '')) as run:
            r.psql('select 1;', 'postgres://snow:s3cret@127.0.0.1:5432/allrice_dev')
        cmd, env = run.call_args[0][0], run.call_args[0][2]
        self.assertNotIn('s3cret', ' '.join(cmd))
        self.assertIn('postgres://snow@127.0.0.1:5432/allrice_dev', cmd)
        self.assertEqual(env['PGPASSWORD'], 's3cret')

    def test_backlog_is_bounded(self):
        r = make_round()
        with mock.patch.object(monitor, 'send_telegram', side_effect=monitor.CheckError('down')):
            for i in range(25):
                monitor.deliver(r, 'm%d' % i)
        self.assertEqual(r.state['outbox'][0], 'm5')
        self.assertEqual(len(r.state['outbox']), 20)
        sent = []
        with mock.patch.object(monitor, 'send_telegram', side_effect=lambda cfg, text: sent.append(text)):
            monitor.deliver(r, None)
        self.assertEqual(sent[0], '（另有 5 条更早的通知没能发出，已丢弃）\nm5')
        self.assertEqual(sent[1], 'm6')


class RunChecks(unittest.TestCase):
    def test_confirm_dependency_and_errors(self):
        r = make_round()
        calls = []

        def flaky(r):
            calls.append('flaky')
            return [bad('flaky')] if len(calls) == 1 else [ok('flaky')]

        def broken(r):
            raise monitor.CheckError('psql missing')

        checks = [('postgres', broken, False, None), ('needs_pg', lambda r: [bad('x')], False, 'postgres'),
                  ('vm', lambda r: None, False, None), ('needs_vm', lambda r: [bad('y')], False, 'vm'),
                  ('flaky', flaky, True, None), ('unknown', lambda r: None, False, None)]
        findings, ran = monitor.run_checks(r, checks)
        self.assertEqual([(f['key'], f['severity']) for f in findings],
                         [('check:postgres', 'warning'), ('check:vm', 'ok'), ('check:flaky', 'ok'), ('flaky', 'ok'), ('check:unknown', 'ok')])
        self.assertEqual(calls, ['flaky', 'flaky'])  # failed once, confirmed ok on the re-run
        self.assertEqual(ran, {'flaky'})  # an erroring or undecided check judged nothing

    def test_an_item_must_fail_on_both_looks(self):
        r = make_round()
        looks = iter([[bad('vm:a'), ok('vm:b')], [ok('vm:a'), bad('vm:b')], [bad('vm:a'), ok('vm:b')], [ok('vm:a'), bad('vm:b')],
                      [ok('vm:a'), bad('vm:b')], [ok('vm:a'), bad('vm:b')]])
        seen = []
        for at in (0, 240, 480):
            findings, ran = monitor.run_checks(r, [('vm', lambda r: next(looks), True, None)])
            seen.append(([(f['key'], f['severity']) for f in findings], step(r, findings, at, ran)))
        self.assertEqual(seen[0], ([('check:vm', 'ok'), ('vm:a', 'ok'), ('vm:b', 'unknown')], []))  # a blipped, b failed once
        self.assertEqual(seen[1][1], [])
        self.assertEqual(seen[2], ([('check:vm', 'ok'), ('vm:a', 'ok'), ('vm:b', 'critical')], [('opened', 'vm:b', False)]))  # both looks

    def test_check_error_alert_recovers(self):
        r = make_round()
        state = {'fail': True}

        def disk(r):
            if state['fail']:
                raise monitor.CheckError('statvfs failed')
            return [ok('disk:~')]

        f, ran = monitor.run_checks(r, [('disk', disk, False, None)])
        self.assertEqual(step(r, f, 0, ran), [('opened', 'check:disk', False)])
        state['fail'] = False
        f, ran = monitor.run_checks(r, [('disk', disk, False, None)])
        self.assertEqual(step(r, f, 300, ran), [('recovered', 'check:disk', False)])

    def test_checks_selection(self):
        r = make_round(checks=['b'], skipChecks=[])
        findings, _ = monitor.run_checks(r, [('a', lambda r: [bad('a')], False, None), ('b', lambda r: [ok('b')], False, None)])
        self.assertEqual([f['key'] for f in findings], ['check:b', 'b'])


class Checks(unittest.TestCase):
    def test_scheduler_states_and_stall(self):
        r = make_round()

        def worker(boot, ticks, faults=0, state='active', **extra):
            ctl = dict({'state': state, 'tickCount': ticks, 'faultCount': faults}, **extra)
            r.facts['worker'] = {'identity': {'bootId': boot}, 'nativeOnceControl': ctl, 'nativeRecurringControl': dict(ctl)}
            return monitor.check_scheduler(r)[0]['severity']

        r.now = 0
        self.assertEqual(worker('b1', 10), 'ok')
        r.now = 239
        self.assertEqual(worker('b1', 10), 'critical')  # ticks stopped, seen on the next round even a second early
        r.now = 600
        self.assertEqual(worker('b2', 10), 'ok')  # restarted: a new baseline, not a stall
        r.now = 700
        self.assertEqual(worker('b2', 11, faults=2), 'warning')
        self.assertEqual(worker('b2', 12, faults=2, state='cold'), 'ok')  # idle, not down
        self.assertEqual(worker('b2', 13, faults=2, state='cold', lastFault={'phase': 'initialization'}), 'critical')
        self.assertEqual(worker('b2', 14, faults=2, state='quarantined'), 'critical')
        self.assertEqual(worker('b2', 15, faults=2, state='starting'), 'ok')
        r.now = 1400
        self.assertEqual(worker('b2', 16, faults=2, state='starting'), 'warning')  # stuck starting
        self.assertEqual(worker('b2', 17, faults=2, state='disabled'), 'ok')
        r.facts['worker'] = {'identity': {'bootId': 'b2'}}
        self.assertEqual(monitor.check_scheduler(r)[0]['severity'], 'ok')  # not configured at all

    def test_a_refused_takeover_pages(self):
        # MET-210 #3 (10-25 23:25): the database stopped under the Worker, the partitions
        # stayed held without a close proof and every later Worker stayed cold and ready.
        r = make_round()
        held = {'partition': 'allrice-once-v1', 'epoch': 10, 'owner': 'f4423f7e', 'open': True, 'expired': 43000, 'proof': False, 'pending': 0}
        closed = dict(held, open=False, proof=True)

        def judge(at, once='cold', rows=(), boot='b1'):
            r.now = at
            r.facts['worker'] = {'identity': {'bootId': boot}, 'nativeOnceControl': {'state': once, 'tickCount': at},
                                 'nativeRecurringControl': {'state': 'active', 'tickCount': at}}
            monitor.check_scheduler(r)
            with mock.patch.object(monitor, 'biz', return_value={'partitions': list(rows)}) as q:
                f = monitor.check_scheduler_takeover(r)[0]
            return f['severity'], q.called, f['detail']

        self.assertEqual(judge(0, rows=[held])[:2], ('ok', False))  # first sight of cold: not even asked
        sev, asked, detail = judge(239, rows=[held])  # still cold on the next round, even a second early
        self.assertEqual((sev, asked), ('critical', True))
        self.assertIn('f4423f7e', detail)
        self.assertIn('已过期', detail)
        self.assertEqual(judge(240, rows=[closed])[0], 'warning')  # closed with its proof and still not taken
        self.assertEqual(judge(241, rows=[dict(closed, pending=1)])[0], 'critical')  # a reminder waits for the clock
        self.assertEqual(judge(242, rows=[dict(closed, proof=False)])[0], 'critical')  # closed, proof not the audited one
        sev, _, detail = judge(243, rows=[dict(held, expired=-20)])  # held and renewed by someone else: schedules still run there
        self.assertEqual(sev, 'warning')
        self.assertIn('另一个 Worker', detail)
        self.assertEqual(judge(243, rows=[dict(held, expired=-20, pending=2)])[0], 'critical')
        self.assertEqual(judge(244, once='active', rows=[held])[:2], ('ok', False))
        self.assertEqual(judge(500, rows=[held], boot='b2')[:2], ('ok', False))  # a new Worker gets the grace again
        r.facts.pop('worker')
        self.assertIsNone(monitor.check_scheduler_takeover(r))  # Worker not ready: the worker alert says it

    def test_restart_loop_but_not_a_deploy(self):
        r = make_round(restartCritical=3)
        runs = iter([1, 2, 4, 1, 1])
        with mock.patch.object(monitor, 'job_info', side_effect=lambda label: ('running', next(runs) if label == 'worker' else 1, '1')):
            sev = []
            for i in range(5):
                r.now = i * 300
                sev.append([f['severity'] for f in monitor.check_restarts(r) if f['key'] == 'restarts:worker'][0])
        self.assertEqual(sev, ['ok', 'ok', 'critical', 'critical', 'critical'])  # one restart is not a loop; the deploy (→1) adds nothing
        r.now = 4 * 300 + 3600
        with mock.patch.object(monitor, 'job_info', return_value=('running', 1, '1')):
            self.assertEqual([f['severity'] for f in monitor.check_restarts(r) if f['key'] == 'restarts:worker'], ['ok'])

    def test_subscription_and_quota(self):
        r = make_round()

        def judge(*items):
            with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps(list(items))):
                return {f['key']: f['severity'] for f in monitor.check_subscription(r)}

        def slot(status='connected', age=60, used=10, reached=False, window='available'):
            return {'slot': 1, 'label': 'metasnowsky', 'status': status, 'detail': 'x', 'ageSeconds': age,
                    'quota': {'status': 'available' if window == 'available' else 'error', 'detailCode': 'codex_quota_x',
                              'buckets': [{'limitReached': reached, 'windows': [{'status': window, 'usedPercent': used}, {'status': 'unknown', 'usedPercent': None}]}]}}

        self.assertEqual(judge(), {'subscription': 'critical'})
        self.assertEqual(judge(slot()), {'subscription': 'ok', 'quota': 'ok'})
        self.assertEqual(judge(slot(status='disconnected')), {'subscription': 'critical', 'quota': 'ok'})
        self.assertEqual(judge(slot(age=7200)), {'subscription': 'warning', 'quota': 'ok'})
        self.assertEqual(judge(slot(used=85))['quota'], 'warning')
        self.assertEqual(judge(slot(used=97))['quota'], 'critical')
        self.assertEqual(judge(slot(reached=True))['quota'], 'critical')
        r.now = 0
        self.assertEqual(judge(slot(used=None, window='unknown')), {'subscription': 'ok', 'quota': 'unknown'})  # not judged
        self.assertEqual(judge(slot(used=40, window='unknown'))['quota'], 'unknown')  # a percentage outside a measured window does not count
        r.now = 31 * 60
        self.assertEqual(judge(slot(used=None, window='unknown'))['quota'], 'warning')  # unreadable for long
        self.assertEqual(judge(slot())['quota'], 'ok')
        r.now = 32 * 60
        self.assertEqual(judge(slot(used=None, window='unknown'))['quota'], 'unknown')  # a new gap starts over

    def test_quota_alert_survives_its_window_going_unknown(self):
        r = make_round()

        def row(primary, secondary):
            win = lambda name, v: {'slot': name, 'status': 'available' if v is not None else 'unknown', 'usedPercent': v}
            return {'slot': 1, 'label': 'x', 'status': 'connected', 'detail': '', 'ageSeconds': 1,
                    'quota': {'status': 'available', 'buckets': [{'limitId': 'codex', 'windows': [win('primary', primary), win('secondary', secondary)]}]}}

        for at, data, want in ((0, row(10, 97), [('opened', 'quota', False)]), (300, row(10, None), []), (600, row(10, 20), [('recovered', 'quota', False)])):
            with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps([data])):
                findings, ran = monitor.run_checks(r, [('subscription', monitor.check_subscription, False, None)])
            self.assertEqual([e for e in step(r, findings, at, ran) if e[1] == 'quota'], want, at)

    def test_quota_limit_alert_needs_the_provider_to_clear_it(self):
        r = make_round()

        def row(reached):
            return {'slot': 1, 'label': 'x', 'status': 'connected', 'detail': '', 'ageSeconds': 1,
                    'quota': {'status': 'available', 'buckets': [{'limitId': 'codex', 'limitReached': reached,
                                                                  'windows': [{'slot': 'primary', 'status': 'available', 'usedPercent': 10}]}]}}

        for at, reached, want in ((0, True, [('opened', 'quota', False)]), (240, None, []), (480, False, [('recovered', 'quota', False)])):
            with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps([row(reached)])):
                findings, ran = monitor.run_checks(r, [('subscription', monitor.check_subscription, False, None)])
            self.assertEqual([e for e in step(r, findings, at, ran) if e[1] == 'quota'], want, at)

    def test_quota_alert_is_not_recovered_by_an_unreadable_quota(self):
        r = make_round()
        high = {'slot': 1, 'label': 'x', 'status': 'connected', 'detail': '', 'ageSeconds': 1,
                'quota': {'status': 'available', 'buckets': [{'windows': [{'status': 'available', 'usedPercent': 97}]}]}}
        lost = dict(high, quota={'status': 'error', 'buckets': []})
        for at, row, want in ((0, high, [('opened', 'quota', False)]), (300, lost, [])):
            with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps([row])):
                findings, ran = monitor.run_checks(r, [('subscription', monitor.check_subscription, False, None)])
            self.assertEqual([e for e in step(r, findings, at, ran) if e[1] == 'quota'], want)

    def test_public_entry_waits_out_a_deploy(self):
        r = make_round(publicUrl='https://a.example')
        with mock.patch.object(monitor, 'lock_holders', return_value=['4242']):
            self.assertIsNone(monitor.check_public_entry(r))
        r.facts.clear()
        with mock.patch.object(monitor, 'lock_holders', return_value=[]), mock.patch.object(monitor, 'http_get', return_value=(502, b'bad gateway')):
            self.assertEqual(monitor.check_public_entry(r)[0]['severity'], 'critical')

    def test_public_entry_probes_every_hostname(self):
        r = make_round(publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://A.example/login', 'https://c.example'])
        answers = {'https://a.example': (200, b'login'), 'https://b.example': (200, b'login'), 'https://c.example': (530, b'error 1033')}

        def probe():
            with mock.patch.object(monitor, 'lock_holders', return_value=[]), \
                    mock.patch.object(monitor, 'http_get', side_effect=lambda url, *a: answers[url]):  # a.example again: KeyError, check:public_entry
                return monitor.run_checks(r, [('public_entry', monitor.check_public_entry, True, None)])
        findings, ran = probe()
        self.assertEqual({f['key']: f['severity'] for f in findings},
                         {'check:public_entry': 'ok', 'public_entry': 'ok', 'public_entry:b.example': 'ok', 'public_entry:c.example': 'critical'})
        self.assertEqual(step(r, findings, 0, ran), [('opened', 'public_entry:c.example', False)])
        self.assertEqual(r.state['alerts']['public_entry:c.example']['title'], '公网入口不可达（c.example）')
        r.cfg['extraPublicUrls'] = ['https://b.example']
        findings, ran = probe()
        self.assertEqual(step(r, findings, 300, ran), [('recovered', 'public_entry:c.example', False)])  # left the config

    def test_m1_probes_every_entry_the_tunnel_serves(self):
        r = make_round(publicUrl='https://a.bplabs.xyz')  # the shipped extraPublicUrls
        probed = []

        def get(url, *a):
            probed.append(url)
            return 200, b'ok'
        with mock.patch.object(monitor, 'lock_holders', return_value=[]), mock.patch.object(monitor, 'http_get', side_effect=get):
            keys = [f['key'] for f in monitor.check_public_entry(r)]
        self.assertEqual(keys, ['public_entry', 'public_entry:allrice.bplabs.xyz', 'public_entry:allrice-admin.bplabs.xyz',
                                'public_entry:allrice-dsh.bplabs.xyz'])
        # Rice Bridge pairs with allrice-dsh; its root redirects to allrice-admin, so it is probed on a path of its own
        self.assertIn('https://allrice-dsh.bplabs.xyz/api/health/ready', probed)

    def test_public_entry_probes_hostnames_at_once(self):
        r = make_round(publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://c.example'])
        together = threading.Barrier(3, timeout=5)  # one at a time would break it

        def get(url, *a):
            together.wait()
            return 200, b'login'
        with mock.patch.object(monitor, 'lock_holders', return_value=[]), mock.patch.object(monitor, 'http_get', side_effect=get):
            self.assertEqual([(f['key'], f['severity']) for f in monitor.check_public_entry(r)],
                             [('public_entry', 'ok'), ('public_entry:b.example', 'ok'), ('public_entry:c.example', 'ok')])

    def scripted(self, replies):
        """Each hostname gives its next reply in turn; None never answers (a DNS lookup that hangs)."""
        release, lock = threading.Event(), threading.Lock()
        self.addCleanup(release.set)

        def get(url, *a):
            with lock:
                code = replies[urllib.parse.urlsplit(url).hostname].pop(0)
            if code is None:
                release.wait()
            return code, b'reply'
        return mock.patch.object(monitor, 'http_get', side_effect=get)

    def round_limit(self, seconds):
        """The round's time limit strikes after `seconds`, as do_round's alarm does."""
        old = signal.signal(signal.SIGALRM, monitor.on_alarm)
        self.addCleanup(signal.signal, signal.SIGALRM, old)
        self.addCleanup(signal.setitimer, signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_REAL, seconds)

    def test_a_hung_hostname_has_a_deadline(self):
        r = make_round(publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://c.example'])
        start = time.time()
        with mock.patch.object(monitor, 'PUBLIC_PROBE_SECONDS', 0.2), mock.patch.object(monitor, 'lock_holders', return_value=[]), \
                self.scripted({'a.example': [200], 'b.example': [502], 'c.example': [None]}):
            out = monitor.check_public_entry(r)
        self.assertLess(time.time() - start, 0.2 + 2 + 1)  # the probe's timeout plus 2 seconds, not "forever"
        self.assertEqual([(f['key'], f['severity']) for f in out],
                         [('public_entry', 'ok'), ('public_entry:b.example', 'critical'), ('public_entry:c.example', 'critical')])
        self.assertIn('没有结果', out[2]['detail'])

    def test_round_timeout_keeps_the_hostnames_already_probed(self):
        r = make_round(publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://c.example'])
        step(r, [bad('public_entry'), bad('public_entry:c.example')], 0, {'public_entry'})
        self.round_limit(0.5)  # strikes on the first look, while c.example hangs
        with mock.patch.object(monitor, 'lock_holders', return_value=[]), self.assertRaises(monitor.RoundTimeout), \
                self.scripted({'a.example': [200], 'b.example': [502], 'c.example': [None]}):
            monitor.run_checks(r, [('public_entry', monitor.check_public_entry, True, None)])
        findings, ran = monitor.collect_checks(r)
        self.assertEqual(sorted((f['key'], f['severity']) for f in findings), [('public_entry', 'ok'), ('public_entry:b.example', 'unknown')])
        self.assertEqual(ran, set())  # not judged: c.example's open alert must not recover
        self.assertEqual(step(r, findings, 240, ran), [('recovered', 'public_entry', False)])

    def test_round_timeout_during_the_re_check(self):
        r = make_round(publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://c.example'])
        step(r, [bad('public_entry:b.example')], 0, {'public_entry'})
        self.round_limit(0.5)  # strikes on the re-check, while a.example hangs
        with mock.patch.object(monitor, 'lock_holders', return_value=[]), self.assertRaises(monitor.RoundTimeout), \
                self.scripted({'a.example': [502, None], 'b.example': [200, 502], 'c.example': [200, 200]}):
            monitor.run_checks(r, [('public_entry', monitor.check_public_entry, True, None)])
        findings, ran = monitor.collect_checks(r)
        self.assertEqual([(f['key'], f['severity']) for f in findings],
                         [('check:public_entry', 'ok'), ('public_entry', 'unknown'),  # failed once, never looked at again
                          ('public_entry:b.example', 'unknown'), ('public_entry:c.example', 'ok')])  # b: fine, then failed
        self.assertEqual(step(r, findings, 240, ran), [])  # neither opens a nor recovers b

    def test_a_hung_probe_does_not_keep_the_process_alive(self):
        code = '''
import importlib.machinery, importlib.util, json, sys, tempfile, threading
loader = importlib.machinery.SourceFileLoader('monitor', sys.argv[1])
spec = importlib.util.spec_from_loader('monitor', loader)
monitor = importlib.util.module_from_spec(spec)
loader.exec_module(monitor)
monitor.PUBLIC_PROBE_SECONDS = 0.2
monitor.lock_holders = lambda path: []
monitor.http_get = lambda url, *a: threading.Event().wait() or (200, b'')
cfg = json.loads(json.dumps(monitor.M1))
cfg.update(stateDir=tempfile.mkdtemp(), publicUrl='https://a.example', extraPublicUrls=['https://b.example', 'https://c.example'])
print(len(monitor.check_public_entry(monitor.Round(cfg))))
'''
        p = subprocess.run([sys.executable, '-c', code, os.path.join(HERE, 'monitor')], capture_output=True, text=True, timeout=20)
        self.assertEqual((p.returncode, p.stdout.strip()), (0, '3'), p.stderr)  # exited, with every probe still hanging

    def test_sandbox_vm(self):
        r = make_round(colimaProfile='cloud', extraColimaProfiles=['drill'])

        attest = {'ready': True}

        def fake_run(cmd, timeout=20, env=None, stdin=None):
            if cmd[1] == 'status':
                return (0, '', '') if cmd[-1] == 'cloud' else (1, '', 'not running')
            if cmd[-1] == '--attest':
                return (0, json.dumps(attest) + '\n', '')
            return (0, service[0] + '\n', '')  # colima ssh … systemctl is-active

        service = ['inactive']

        with mock.patch.object(monitor, 'run', side_effect=fake_run), mock.patch.object(monitor.Round, 'docker', return_value=(0, '27.0', '')), \
                mock.patch.object(monitor, 'lock_holders', return_value=[]):
            got = {f['key']: f['severity'] for f in monitor.check_sandbox_vm(r)}
        self.assertEqual(got, {'sandbox_vm:cloud': 'critical', 'sandbox_vm:drill': 'critical'})  # watchdog down; drill VM stopped
        self.assertTrue(r.facts['vmOk'])  # docker answers: images and Office are still checked
        r.facts.clear()
        with mock.patch.object(monitor, 'run', side_effect=fake_run), mock.patch.object(monitor, 'lock_holders', return_value=['9']):
            got = {f['key']: f['severity'] for f in monitor.check_sandbox_vm(r)}
        self.assertEqual(got, {'sandbox_vm:cloud': 'unknown', 'sandbox_vm:drill': 'critical'})  # shared VM under planned work: not judged
        self.assertFalse(r.facts['vmOk'])
        service[0], attest['ready'] = 'active', False  # the service runs but cannot attest (runsc lost after a VM restart)
        r.facts.clear()
        with mock.patch.object(monitor, 'run', side_effect=fake_run), mock.patch.object(monitor.Round, 'docker', return_value=(0, '27.0', '')), \
                mock.patch.object(monitor, 'lock_holders', return_value=[]):
            f = [f for f in monitor.check_sandbox_vm(r) if f['key'] == 'sandbox_vm:cloud'][0]
        self.assertEqual(f['severity'], 'critical')
        self.assertIn('--attest', f['detail'])
        attest['ready'] = None
        r.facts.clear()
        with mock.patch.object(monitor, 'run', side_effect=fake_run), mock.patch.object(monitor.Round, 'docker', return_value=(0, '27.0', '')), \
                mock.patch.object(monitor, 'lock_holders', return_value=[]):
            self.assertEqual([f['severity'] for f in monitor.check_sandbox_vm(r) if f['key'] == 'sandbox_vm:cloud'], ['critical'])
        attest['ready'] = True
        with mock.patch.object(monitor, 'run', side_effect=fake_run), mock.patch.object(monitor.Round, 'docker', return_value=(0, '27.0', '')), \
                mock.patch.object(monitor, 'lock_holders', return_value=[]):
            self.assertEqual([f['severity'] for f in monitor.check_sandbox_vm(r) if f['key'] == 'sandbox_vm:cloud'], ['ok'])

    def test_authorization_error_must_last(self):
        r = make_round()
        row = {'slot': 1, 'label': 'x', 'status': 'error', 'detail': 'probe', 'ageSeconds': 1, 'quota': {}}
        with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps([row])):
            r.now = 0
            self.assertEqual(monitor.check_subscription(r)[0]['severity'], 'unknown')  # not a recovery either
            r.now = 239  # the next 4-minute round, a second early
            self.assertEqual(monitor.check_subscription(r)[0]['severity'], 'critical')
        with mock.patch.object(monitor.Round, 'psql', return_value=json.dumps([dict(row, status='disconnected')])):
            r.state.clear()
            self.assertEqual(monitor.check_subscription(r)[0]['severity'], 'critical')  # logged out: at once

    def test_disk_thresholds(self):
        r = make_round(disks=[{'path': '/', 'warnFreeGiB': 10 ** 9, 'criticalFreeGiB': 0}])
        self.assertEqual(monitor.check_disk(r)[0]['severity'], 'warning')
        r.cfg['disks'] = [{'path': '/', 'warnFreeGiB': 10 ** 9, 'criticalFreeGiB': 10 ** 9}]
        self.assertEqual(monitor.check_disk(r)[0]['severity'], 'critical')
        r.cfg['disks'] = [{'path': '/', 'warnFreeGiB': 0, 'criticalFreeGiB': 0}]
        self.assertEqual(monitor.check_disk(r)[0]['severity'], 'ok')

    def test_memory_and_dsh_processes(self):
        def fake(free, dsh, memory_fails=False):
            ps = ''.join('180000 /opt/node/bin/node /r/apps/worker/dsh/allrice-jsonrpc-runtime.mjs\n' for _ in range(dsh))
            ps += '456000 /opt/node/bin/node /r/apps/worker/dist/index.js\n'
            ps += '1200 grep allrice-jsonrpc-runtime.mjs\n'  # a diagnostic command naming it is not counted

            def run(cmd, **kw):
                if cmd[0].endswith('memory_pressure'):
                    if memory_fails:
                        return 1, '', 'boom'
                    return 0, 'System-wide memory free percentage: %d%%\n' % free, ''
                return 0, ps, ''
            return run

        r = make_round(memoryWarnFreePct=20, memoryCriticalFreePct=10, dshWarnProcesses=30)
        cases = [(76, 9, 'ok', 'ok'), (20, 29, 'ok', 'ok'), (19, 30, 'warning', 'warning'),
                 (10, 0, 'warning', 'ok'), (9, 29, 'critical', 'ok')]
        for free, dsh, memory, procs in cases:
            with mock.patch.object(monitor, 'run', side_effect=fake(free, dsh)):
                found = {f['key']: f for f in monitor.check_memory(r)}
            self.assertEqual((found['memory']['severity'], found['dsh_processes']['severity']), (memory, procs), (free, dsh))
        self.assertEqual(r.facts['dshProcesses'], {'count': 29, 'mb': 29 * 180000 // 1024})
        # One source failing leaves only that key unjudged.
        with mock.patch.object(monitor, 'run', side_effect=fake(50, 3, memory_fails=True)):
            found = {f['key']: f['severity'] for f in monitor.check_memory(r)}
        self.assertEqual(found, {'memory': 'unknown', 'dsh_processes': 'ok'})
        with mock.patch.object(monitor, 'run', return_value=(1, '', 'boom')):
            found = {f['key']: f['severity'] for f in monitor.check_memory(r)}
        self.assertEqual(found, {'memory': 'unknown', 'dsh_processes': 'unknown'})

    def test_backup_age(self):
        r = make_round(backupLabel=None)
        log = os.path.join(r.cfg['stateDir'], 'backup.log')
        r.cfg['backupLog'] = log
        with open(log, 'w') as f:
            f.write('2026-10-24 04:00:05 ok db=2.8M files=1.9M\nTraceback: later failure\n')
        when = monitor.time.mktime(monitor.time.strptime('2026-10-24 04:00:05', '%Y-%m-%d %H:%M:%S'))
        for hours, want in ((2, 'ok'), (30, 'warning'), (60, 'critical')):
            r.now = when + hours * 3600
            self.assertEqual(monitor.check_backup(r)[0]['severity'], want, hours)
        r.now, r.cfg['backupLabel'] = when + 2 * 3600, 'backup'
        with mock.patch.object(monitor, 'job_info', return_value=('loaded', 3, '1')):
            self.assertEqual(monitor.check_backup(r)[0]['severity'], 'critical')  # tonight's run failed: now, not in 26 hours
        with mock.patch.object(monitor, 'job_info', return_value=('gone', None, None)):
            self.assertEqual(monitor.check_backup(r)[0]['severity'], 'warning')
        r.cfg['backupLabel'] = None
        open(log, 'w').close()
        self.assertEqual(monitor.check_backup(r)[0]['severity'], 'critical')


class Worker(unittest.TestCase):
    def test_blocked_schedule_controller_asks_for_a_restart(self):
        r = make_round()
        body = json.dumps({'status': 'not_ready', 'detail': 'native_once_blocked',
                           'nativeOnceControl': {'state': 'blocked', 'lastFault': {'phase': 'shutdown', 'code': 'shutdown_failed'}}}).encode()
        with mock.patch.object(monitor, 'http_get', return_value=(503, body)), mock.patch.object(monitor, 'job_info', return_value=('running', 1, None)), \
                mock.patch.object(monitor, 'lock_holders', return_value=[]):
            got = monitor.check_worker(r)
        self.assertEqual([(x['key'], x['severity']) for x in got], [('worker', 'critical'), ('worker_stuck', 'critical')])
        f = got[1]
        self.assertEqual(f['title'], 'Worker 定时控制器卡住，要重启 Worker')
        self.assertIn('shutdown_failed', f['detail'])
        self.assertIn('kickstart -k', f['step'])
        step(r, [got[0]], 0)  # "Worker 不可用" already open from the outage that caused it
        self.assertEqual(step(r, got, 240), [('opened', 'worker_stuck', False)])  # still told
        with mock.patch.object(monitor, 'http_get', return_value=(503, json.dumps({'status': 'not_ready', 'detail': 'database_unavailable'}).encode())), \
                mock.patch.object(monitor, 'job_info', return_value=('running', 1, None)), mock.patch.object(monitor, 'lock_holders', return_value=[]):
            got = monitor.check_worker(r)
        self.assertEqual([(x['key'], x['severity']) for x in got], [('worker', 'critical'), ('worker_stuck', 'ok')])
        self.assertIn('detail=database_unavailable', got[0]['detail'])

    def test_a_large_503_is_read_whole(self):
        import http.server
        import threading
        body = json.dumps({'status': 'not_ready', 'detail': 'native_once_blocked', 'refs': ['x' * 64] * 2000}).encode()

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(503)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            doc, why, answer = monitor.ready('http://127.0.0.1:%d/health/ready' % srv.server_address[1])
        finally:
            srv.shutdown()
        self.assertGreater(len(body), 65536)
        self.assertEqual((doc, answer['detail']), (None, 'native_once_blocked'))


class Deploys(unittest.TestCase):
    def test_planned_work_is_not_an_outage_for_a_bounded_time(self):
        r = make_round()
        inflight = os.path.join(r.cfg['stateDir'], 'inflight')
        r.cfg.update(deployInflight=inflight)
        with mock.patch.object(monitor, 'lock_holders', return_value=['4242']):
            self.assertIsNone(monitor.check_web(r))  # stopped on purpose: not judged
            self.assertIsNone(monitor.check_postgres(r))
            os.mkdir(inflight)
            self.assertEqual(monitor.check_deploy(r)[0]['severity'], 'ok')
            r.facts.clear()
            r.now += 46 * 60  # held longer than the grace: judged like an outage again
            self.assertFalse(monitor.deploying(r))
            self.assertEqual(monitor.check_deploy(r)[0]['severity'], 'critical')
        r.facts.clear()
        with mock.patch.object(monitor, 'lock_holders', return_value=[]):
            self.assertFalse(monitor.deploying(r))  # released: also a later hold starts a new grace
        self.assertEqual(r.state['deploySeen'], {})

    def test_round_timeout_keeps_what_was_found(self):
        r = make_round(incidents=False, dailyHour=99)

        def stuck(r):
            raise monitor.RoundTimeout()

        checks = [('a', lambda r: [bad('a')], False, None), ('slow', stuck, False, None)]
        with mock.patch.object(monitor, 'M1_CHECKS', checks):
            monitor.do_round(r.cfg, False)
        state = json.load(open(os.path.join(r.cfg['stateDir'], 'state.json')))
        self.assertEqual(set(state['alerts']), {'a', 'monitor_round'})
        self.assertIn('slow', state['alerts']['monitor_round']['detail'])
        hb = json.load(open(os.path.join(r.cfg['stateDir'], 'heartbeat.json')))
        self.assertEqual((hb['phase'], hb['unfinishedSince']), ('done', None))

    def test_corrupt_state_is_kept_and_reported(self):
        r = make_round(incidents=False, dailyHour=99, checks=[])
        with open(os.path.join(r.cfg['stateDir'], 'state.json'), 'w') as f:
            f.write('{"alerts": {')
        monitor.do_round(r.cfg, False)
        state = json.load(open(os.path.join(r.cfg['stateDir'], 'state.json')))
        self.assertIn('monitor_state', state['alerts'])
        self.assertTrue([n for n in os.listdir(r.cfg['stateDir']) if n.startswith('state.json.corrupt-')])

    def test_ingest_validates_rows(self):
        r = make_round()
        with self.assertRaises(SystemExit):
            monitor.ingest_incidents(r.cfg, io.StringIO('[{"kind": "kill_switch", "id": "x"}]'))
        row = {'id': '00000000-0000-4000-8000-000000000000', 'kind': 'monitor_alert', 'detailCode': 'monitor.m1_heartbeat', 'metadata': {}}
        with mock.patch.object(monitor, 'psql', return_value='') as psql:
            monitor.ingest_incidents(r.cfg, io.StringIO(json.dumps([row])))
        self.assertIn('allrice_operational_incidents', psql.call_args[0][1])


class Peer(unittest.TestCase):
    def remote(self, hb, err='', reachable=True, holders=None):
        return mock.patch.object(monitor, 'read_remote_heartbeat', return_value=(hb, err, reachable, holders))

    def test_m1_side_judgement(self):
        r = make_round(peer=True)
        r.now = 10_000
        sev = lambda: {f['key']: f['severity'] for f in monitor.check_m1(r)}
        with self.remote(None, 'SSH 连不上 m1', False):
            self.assertEqual(sev(), {'m1_reachable': 'critical'})  # heartbeat unknown, not stale
        fresh = {'at': 9_800, 'phase': 'done', 'telegram': {'configured': True, 'pending': 0}, 'publicUrl': 'https://a.example'}
        with self.remote(fresh, holders=[]):
            self.assertEqual(sev(), {'m1_reachable': 'ok', 'm1_heartbeat': 'ok', 'm1_telegram': 'ok'})
        self.assertEqual(r.state['m1PublicUrl'], 'https://a.example')
        with self.remote(dict(fresh, at=10_000 - 7 * 60)):
            self.assertEqual(sev()['m1_heartbeat'], 'critical')  # stopped
        with self.remote(dict(fresh, at=9_900, phase='running', unfinishedSince=10_000 - 7 * 60)):
            self.assertEqual(sev()['m1_heartbeat'], 'critical')  # starts every round, finishes none
        with self.remote(dict(fresh, at=9_900, phase='running', unfinishedSince=9_900)):
            self.assertEqual(sev()['m1_heartbeat'], 'ok')  # a round in progress
        with self.remote(dict(fresh, telegram={'configured': True, 'pending': 3, 'failingSince': 10_000 - 9 * 60})):
            self.assertEqual(sev()['m1_telegram'], 'warning')
        with self.remote(dict(fresh, telegram={'configured': True, 'pending': 3, 'failingSince': 10_000 - 60})):
            self.assertEqual(sev()['m1_telegram'], 'ok')  # one failed round is not stuck yet
        with self.remote(None, '读不到 m1:allrice-dev/monitor/heartbeat.json'):
            self.assertEqual(sev()['m1_heartbeat'], 'critical')

    def test_public_probe_waits_out_a_deploy_on_m1(self):
        r = make_round(peer=True)
        r.state['m1PublicUrl'] = 'https://a.example'
        fresh = {'at': r.now, 'phase': 'done', 'telegram': {'configured': True}}
        with self.remote(fresh, holders=['777']), mock.patch.object(monitor, 'http_get', return_value=(502, b'bad gateway')):
            self.assertIsNone(monitor.check_outside(r))  # down while M1 deploys: not judged
        with self.remote(fresh, holders=[]), mock.patch.object(monitor, 'http_get', return_value=(502, b'bad gateway')):
            self.assertEqual(monitor.check_outside(r)[0]['severity'], 'critical')
        with self.remote(fresh, holders=['777']), mock.patch.object(monitor, 'http_get', return_value=(200, b'ok')):
            self.assertEqual(monitor.check_outside(r)[0]['severity'], 'ok')  # up during a deploy is still up

    def test_m1_judges_the_peer_the_same_way(self):
        r = make_round()
        r.now = 10_000
        sev = lambda: {f['key']: f['severity'] for f in monitor.check_peer(r)}
        hb = {'at': 9_990, 'phase': 'done', 'telegram': {'configured': True, 'pending': 0}}
        with self.remote(hb):
            self.assertEqual(sev(), {'peer': 'ok', 'peer_telegram': 'ok'})
        with self.remote(dict(hb, telegram={'configured': True, 'pending': 20, 'failingSince': 10_000 - 3600})):
            self.assertEqual(sev()['peer_telegram'], 'warning')  # alive but cannot alert anybody
        with self.remote(dict(hb, at=10_000 - 5 * 60)):
            self.assertEqual(sev()['peer'], 'warning')
        with self.remote(None, 'SSH 连不上 huihuimac', False):
            self.assertEqual(sev(), {'peer': 'warning'})


class Config(unittest.TestCase):
    def test_merge(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, 'c.json')
        with open(path, 'w') as f:
            json.dump({'stateDir': tmp, 'repeatMinutes': {'warning': 30}, 'label': '演练'}, f)
        cfg = monitor.load_config(path, False)
        self.assertEqual(cfg['repeatMinutes'], {'critical': 60, 'warning': 30})
        self.assertEqual(cfg['telegramEnv'], os.path.join(tmp, 'telegram.env'))
        self.assertEqual(cfg['label'], '演练')
        peer = monitor.load_config(path, True)
        self.assertEqual(peer['telegramEnv'], os.path.expanduser('~/.config/allrice-monitor/telegram.env'))


class Business(unittest.TestCase):
    def judge(self, fn, row, **cfg):
        r = make_round()
        r.cfg['business'] = dict(r.cfg['business'], **cfg)
        with mock.patch.object(monitor, 'biz', return_value=row), mock.patch.object(monitor, 'deploying', return_value=False):
            out = fn(r)
        return None if out is None else out[0]['severity']

    def test_failed_runs_needs_volume_and_a_jump(self):
        row = lambda n, total, pct, base: {'count': n, 'total': total, 'pct': pct, 'baseline_pct': base, 'codes': ['X'], 'samples': []}
        self.assertEqual(self.judge(monitor.check_failed_runs, row(2, 2, 100, 0)), 'ok')  # too few runs to judge
        self.assertEqual(self.judge(monitor.check_failed_runs, row(3, 10, 30, 5)), 'warning')
        self.assertEqual(self.judge(monitor.check_failed_runs, row(3, 15, 20, 15)), 'ok')  # no jump over the baseline, below the sustained line
        self.assertEqual(self.judge(monitor.check_failed_runs, row(6, 10, 60, 50)), 'critical')
        self.assertEqual(self.judge(monitor.check_failed_runs, row(4, 10, 40, 40)), 'warning')  # sustained: its own baseline is high
        self.assertEqual(self.judge(monitor.check_failed_runs, row(3, 3, 100, 0)), 'warning')  # low traffic, nothing succeeds
        self.assertEqual(self.judge(monitor.check_failed_runs, row(3, 4, 75, 0)), 'warning')  # low traffic, most fail
        self.assertEqual(self.judge(monitor.check_failed_runs, row(2, 4, 50, 0)), 'ok')
        self.assertEqual(self.judge(monitor.check_failed_runs, row(3, 10, 30, 30)), 'warning')  # sustained 30%

    def test_queue_and_stuck_wait_out_maintenance(self):
        q = {'count': 2, 'samples': [], 'oldest': 400, 'active': 1, 'admission': 'open'}
        self.assertEqual(self.judge(monitor.check_queue, q), 'warning')
        self.assertEqual(self.judge(monitor.check_queue, dict(q, oldest=1000)), 'critical')
        self.assertEqual(self.judge(monitor.check_queue, dict(q, active=0)), 'critical')  # nobody is claiming
        self.assertIsNone(self.judge(monitor.check_queue, dict(q, admission='closed')))
        self.assertIsNone(self.judge(monitor.check_stuck_runs, {'count': 1, 'samples': [], 'reasons': [], 'admission': 'draining'}))
        self.assertEqual(self.judge(monitor.check_stuck_runs, {'count': 1, 'samples': ['abc'], 'reasons': ['lease_expired'], 'admission': 'open'}), 'critical')

    def test_schedules(self):
        row = {'count': 0, 'samples': [], 'oldest': None, 'reasons': [], 'legacy': 0, 'host_down': None, 'enabled_native': 0, 'admission': 'open'}
        self.assertEqual(self.judge(monitor.check_schedules, row), 'ok')
        self.assertEqual(self.judge(monitor.check_schedules, dict(row, count=1, oldest=700, reasons=['native_once_not_fired'])), 'warning')
        self.assertEqual(self.judge(monitor.check_schedules, dict(row, count=1, oldest=1900)), 'critical')
        self.assertEqual(self.judge(monitor.check_schedules, dict(row, host_down=['allrice-once-v1'])), 'critical')  # SQL lists only partitions with enabled tasks
        with mock.patch.object(monitor, 'biz', return_value=dict(row, host_down=['allrice-once-v1'])), mock.patch.object(monitor, 'deploying', return_value=True):
            self.assertIsNone(monitor.check_schedules(make_round()))  # a deploy stops the Worker and closes partitions on purpose
        self.assertEqual(self.judge(monitor.check_schedules, dict(row, legacy=1)), 'warning')
        self.assertEqual(self.judge(monitor.check_schedules, dict(row, count=1, oldest=None, reasons=['native_once_missed'])), 'warning')

    def test_waits_dead_letters_unknown_bridge(self):
        self.assertEqual(self.judge(monitor.check_waits, {'count': 0, 'orphans': 1, 'samples': [], 'orphan_samples': []}), 'critical')
        self.assertEqual(self.judge(monitor.check_waits, {'count': 5, 'orphans': 0, 'samples': [], 'orphan_samples': []}), 'ok')  # people take their time
        dead = {'count': 1, 'codes': ['LEASE_EXHAUSTED'], 'types': ['t'], 'samples': []}
        self.assertEqual(self.judge(monitor.check_dead_letters, dead), 'warning')
        self.assertEqual(self.judge(monitor.check_dead_letters, dict(dead, codes=['POLICY_DENIED'])), 'critical')
        unk = {'count': 0, 'bridge_unknown': 0, 'bridge_backlog': 0, 'backlog': 4, 'expired': 0, 'samples': [], 'expired_samples': []}
        self.assertEqual(self.judge(monitor.check_unknown_ops, unk), 'warning')  # unresolved: stays until settled
        self.assertEqual(self.judge(monitor.check_unknown_ops, dict(unk, backlog=0)), 'ok')
        self.assertEqual(self.judge(monitor.check_unknown_ops, dict(unk, backlog=0, bridge_backlog=1)), 'warning')  # an old Bridge command too
        self.assertEqual(self.judge(monitor.check_unknown_ops, dict(unk, count=3)), 'critical')
        br = {'count': 5, 'samples': [], 'offline_with_work': 0, 'heartbeat_only': 0, 'expected': 5}
        self.assertEqual(self.judge(monitor.check_bridge, br), 'ok')  # everybody closed the laptop for the night
        self.assertEqual(self.judge(monitor.check_bridge, dict(br, offline_with_work=1)), 'warning')
        self.assertEqual(self.judge(monitor.check_bridge, dict(br, heartbeat_only=1)), 'warning')
        self.assertEqual(self.judge(monitor.check_bridge, dict(br, heartbeat_only=2)), 'critical')

    def test_deadlocks_per_hour_and_stats_reset(self):
        r = make_round()

        def at(t, total, reset=None, job_start=0):
            r.now = t
            with mock.patch.object(monitor, 'biz', return_value={'total': total, 'reset': reset, 'job_start': job_start, 'samples': []}):
                return monitor.check_deadlocks(r)[0]['severity']

        self.assertEqual(at(0, 10), 'ok')
        self.assertEqual(at(300, 11), 'warning')
        self.assertEqual(at(600, 16), 'critical')
        self.assertEqual(at(900, 2, reset='2026-10-25'), 'ok')  # stats reset: a new series, not -14
        self.assertEqual(at(4600, 2, reset='2026-10-25'), 'ok')
        self.assertEqual(at(4900, 2, reset='2026-10-25', job_start=1), 'critical')

    def test_pg_resource_errors_from_the_log(self):
        r = make_round()
        log = os.path.join(r.cfg['stateDir'], 'pg.log')
        r.cfg['pgLog'] = log
        line = lambda db: '2026-10-25 16:14:42.521 CST [12102] %s ERROR:  out of shared memory\n' % db
        with open(log, 'w') as f:
            f.write(line('allrice_b2') * 5)  # history before the monitor started is not counted
        r.now = 0
        self.assertEqual(monitor.check_pg_resources(r)[0]['severity'], 'ok')
        with open(log, 'a') as f:
            f.write(line('allrice_b2') + line('allrice_dev') + '2026-10-25 16:15:00.000 CST [1] allrice_dev LOG:  checkpoint\n')
        r.now = 240
        got = monitor.check_pg_resources(r)[0]
        self.assertEqual(got['severity'], 'warning')
        self.assertIn('allrice_b2 1', got['detail'])
        with open(log, 'a') as f:  # a line still being written is counted once it is complete
            f.write(line('allrice_dev')[:30])
        r.now = 300
        self.assertIn('allrice_dev 1', monitor.check_pg_resources(r)[0]['detail'])
        with open(log, 'a') as f:
            f.write(line('allrice_dev')[30:])
        r.now = 360
        self.assertIn('allrice_dev 2', monitor.check_pg_resources(r)[0]['detail'])
        with open(log, 'w') as f:  # rotated (or truncated): read from the start
            f.write(line('allrice_dev') * 25)
        r.now = 480
        self.assertEqual(monitor.check_pg_resources(r)[0]['severity'], 'critical')
        r.now = 480 + 3601
        self.assertEqual(monitor.check_pg_resources(r)[0]['severity'], 'ok')  # an hour later, nothing new

    def test_failure_groups_new_and_increased(self):
        r = make_round()
        rows = {'groups': [{'code': 'CLOUD_WATCHDOG_UNAVAILABLE', 'today': 4, 'before': 0, 'samples': ['a'], 'messages': []},
                           {'code': 'MODEL_TIMEOUT', 'today': 6, 'before': 7, 'samples': ['b'], 'messages': []},
                           {'code': 'TOOL_DENIED', 'today': 1, 'before': 14, 'samples': ['c'], 'messages': []}]}
        with mock.patch.object(monitor, 'biz', return_value=rows):
            out = monitor.failure_groups(r)
        self.assertEqual([(g['code'], g['kind']) for g in out['groups']],
                         [('CLOUD_WATCHDOG_UNAVAILABLE', 'new'), ('MODEL_TIMEOUT', 'increased'), ('TOOL_DENIED', 'steady')])
        self.assertEqual(out['baselineDays'], 7)
        json.dumps(out)  # exportable as is

    def test_daily_once_a_day(self):
        r = make_round()
        r.now = monitor.time.mktime((2026, 10, 25, 8, 59, 0, 0, 0, -1))
        self.assertFalse(monitor.daily_due(r))
        r.now += 60
        self.assertTrue(monitor.daily_due(r))
        r.state['dailySent'] = '2026-10-25'
        self.assertFalse(monitor.daily_due(r))


class OnlineWaits(unittest.TestCase):
    worker_id = 'd69d8923-e74d-45ab-9b38-1d4eb8f51aa0'

    def row(self, n=1, capacity=4, **overrides):
        return dict({'checked_at': '2026-10-30T08:30:00+00:00', 'online_runs': n, 'occupied_slots': n,
                     'samples': ['cfbc8f02-6bee-4372-b785-d76dc0211224'] if n else [], 'unclassified_runs': 0,
                     'active_workers': [self.worker_id] if n else [],
                     'workers': [{'key': 'worker-operations:' + self.worker_id, 'online': True,
                                  'observed_at': '2026-10-30T08:29:45+00:00',
                                  'value': {'workerId': self.worker_id, 'capacity': {'mode': 'auto', 'concurrency': capacity},
                                            'pressure': {'jobs': {'active': 99}}}}]}, **overrides)

    def collect(self, r, row):
        with mock.patch.object(monitor, 'biz', return_value=row):
            return monitor.check_online_waits(r)

    def test_thresholds_are_configurable_and_not_rounded_before_judging(self):
        for n, capacity, sev in [(0, 4, 'ok'), (3, 4, 'ok'), (4, 5, 'warning'), (19, 20, 'critical')]:
            with self.subTest(n=n, capacity=capacity):
                r = make_round()
                self.assertEqual(self.collect(r, self.row(n, capacity))[0]['severity'], sev)
                self.assertEqual(r.facts['online_waits']['total_slots'], capacity)
        r = make_round()
        r.cfg['business'].update(online_wait_warn_pct=80.01, online_wait_critical_pct=96)
        self.assertEqual(self.collect(r, self.row(4, 5))[0]['severity'], 'ok')
        r.cfg['business']['online_wait_warn_pct'] = 50
        self.assertEqual(self.collect(r, self.row(2, 4))[0]['severity'], 'warning')

    def test_missing_or_invalid_capacity_and_observation_stay_unknown(self):
        rows = [self.row(workers=[]), self.row(active_workers=[None]),
                self.row(0, workers=[]), self.row(unclassified_runs=1)]
        stale = self.row()
        stale['workers'][0]['online'] = False
        rows.append(stale)
        for capacity in [None, 0, -1, 33, True, '4', 2.5]:
            rows.append(self.row(capacity=capacity))
        for row in rows:
            with self.subTest(row=row):
                r = make_round()
                findings = self.collect(r, row)
                self.assertEqual([f['severity'] for f in findings], ['unknown', 'warning'])
                self.assertIsNone(r.facts['online_waits']['occupancy_pct'])
                self.assertIn('未知', findings[0]['detail'])
        r = make_round()
        self.collect(r, self.row(unclassified_runs=1))
        self.assertIsNone(r.facts['online_waits']['online_runs'])
        self.assertIsNone(r.facts['online_waits']['occupied_slots'])

    def test_identity_is_checked_and_global_pressure_does_not_add_slots(self):
        for mutate in [lambda x: x.update(key='worker-operations:forged'),
                       lambda x: x['value'].update(workerId='invalid'),
                       lambda x: x['value']['capacity'].update(mode='invented')]:
            row = self.row()
            mutate(row['workers'][0])
            self.assertEqual(self.collect(make_round(), row)[0]['severity'], 'unknown')
        r = make_round()
        row = self.row()
        row['workers'].append(dict(row['workers'][0], online=False, key='worker-operations:old'))
        self.collect(r, row)
        self.assertEqual(r.facts['online_waits']['occupied_slots'], 1)
        self.assertEqual(r.facts['online_waits']['total_slots'], 4)
        self.assertNotIn('pressure', json.dumps(r.facts))

    def test_collection_or_configuration_failure_cannot_report_zero_healthy(self):
        r = make_round()
        with mock.patch.object(monitor, 'biz', side_effect=monitor.CheckError('relation missing')):
            findings = monitor.check_online_waits(r)
        self.assertEqual([f['severity'] for f in findings], ['unknown', 'warning'])
        self.assertIsNone(r.facts['online_waits']['online_runs'])
        self.assertIsNone(r.facts['online_waits']['occupied_slots'])
        for warn, critical in [(None, 95), (0, 95), (96, 95), (80, 101), ('80', 95), (True, 95)]:
            r = make_round()
            r.cfg['business'].update(online_wait_warn_pct=warn, online_wait_critical_pct=critical)
            self.assertEqual(self.collect(r, self.row(0))[0]['severity'], 'unknown')
        r.cfg['business'] = None
        self.assertEqual(monitor.check_online_waits(r)[0]['severity'], 'unknown')

    def test_dedup_unknown_and_recovery_use_existing_incident_outbox(self):
        r = make_round()
        high = lambda: self.collect(r, self.row(4, 4))
        self.assertEqual(step(r, high(), 0), [('opened', 'business.online_waits', False)])
        self.assertEqual(step(r, high(), 300), [])
        missing = self.collect(r, self.row(4, 4, workers=[]))
        self.assertEqual(step(r, missing, 600), [('opened', 'business.online_waits_data', False)])
        self.assertIn('business.online_waits', r.state['alerts'])
        self.assertEqual(step(r, high(), 900), [('recovered', 'business.online_waits_data', False)])
        self.assertEqual(step(r, self.collect(r, self.row(0)), 1200), [('recovered', 'business.online_waits', False)])
        self.assertEqual(len(r.state['incidentOutbox']), 4)
        self.assertEqual(r.state['alerts'], {})

    def test_known_lower_bound_alerts_even_with_an_unclassified_candidate(self):
        r = make_round()
        row = self.row(4, 5, unclassified_runs=1, possible_online_runs=5, possible_occupied_slots=5,
                       uncertain_reasons=['execution_identity_or_coverage_missing'])
        findings = self.collect(r, row)
        self.assertEqual([f['severity'] for f in findings], ['warning', 'warning'])
        snapshot = r.facts['online_waits']
        self.assertIsNone(snapshot['occupancy_pct'])
        self.assertEqual(snapshot['occupancy_lower_pct'], 80)
        self.assertEqual((snapshot['confirmed_online_runs'], snapshot['possible_online_runs']), (4, 5))
        self.assertIn('已确认Run4/执行位4', findings[0]['detail'])
        self.assertEqual(len(step(r, findings, 0)), 2)

    def test_missing_snapshot_does_not_recover_a_high_alert_but_complete_empty_does(self):
        r = make_round()
        step(r, self.collect(r, self.row(4, 4)), 0)
        conflict = self.row(0, unclassified_runs=1, possible_online_runs=1, possible_occupied_slots=1,
                            uncertain_samples=['legacy-run'], uncertain_reasons=['foreground_snapshot_incomplete_or_stale'])
        findings = self.collect(r, conflict)
        self.assertEqual([f['severity'] for f in findings], ['unknown', 'warning'])
        self.assertEqual(step(r, findings, 100), [('opened', 'business.online_waits_data', False)])
        self.assertIn('business.online_waits', r.state['alerts'])
        self.assertIn('foreground_snapshot_incomplete_or_stale', findings[0]['detail'])
        self.assertEqual(step(r, self.collect(r, self.row(0)), 200), [
            ('recovered', 'business.online_waits', False), ('recovered', 'business.online_waits_data', False)])

    def test_high_ratio_is_rechecked_before_alerting(self):
        r = make_round()
        r.cfg['confirmSeconds'] = 20
        check = next(c for c in monitor.BUSINESS_CHECKS if c[0] == 'online_waits')
        self.assertTrue(check[2])
        with mock.patch.object(monitor, 'biz', side_effect=[self.row(4, 4), self.row(0)]), \
             mock.patch.object(monitor.time, 'sleep') as pause:
            findings, ran = monitor.run_checks(r, [check])
        pause.assert_called_once_with(20)
        self.assertEqual(step(r, findings, 0, ran), [])

    def test_readonly_command_prints_counts_without_delivery_or_state_writes(self):
        r = make_round()
        out = io.StringIO()
        with mock.patch.object(monitor, 'load_config', return_value=r.cfg), \
             mock.patch.object(monitor, 'derive_m1'), mock.patch.object(monitor, 'biz', return_value=self.row()), \
             mock.patch.object(monitor, 'send_telegram', side_effect=AssertionError('no delivery')), \
             mock.patch.object(monitor, 'incident', side_effect=AssertionError('no incident')), mock.patch('sys.stdout', out):
            monitor.main(['online-waits', '--json'])
        snapshot = json.loads(out.getvalue())
        self.assertEqual((snapshot['online_runs'], snapshot['occupied_slots'], snapshot['total_slots'], snapshot['occupancy_pct']), (1, 1, 4, 25))
        self.assertIn('2026-10-30', snapshot['checked_at'])
        self.assertFalse(os.path.exists(r.state_file))

    def test_daily_uses_same_collected_snapshot(self):
        r = make_round()
        self.collect(r, self.row())
        r.facts.update(longWaits=0, bridge={'expected': 0, 'count': 0})
        daily = dict(finished=0, failed=0, canceled=0, dead_letters=0, running=1, waiting=0, unknown_ops=0, schedules=0)
        with mock.patch.object(monitor, 'biz', return_value=daily), \
             mock.patch.object(monitor, 'failure_groups', return_value={'groups': []}):
            lines = monitor.daily_business(r)
        self.assertIn(monitor.online_wait_detail(r.facts['online_waits']), lines)


if __name__ == '__main__':
    unittest.main()
