# Unit tests for scripts/m1/monitor (MET-222): the alert state machine, message
# composition, delivery backlog and the checks' judgement, with every system call stubbed.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
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
        self.assertEqual([x['kind'] for x in rows], ['monitor_alert', 'monitor_alert', 'monitor_recovered'])
        self.assertEqual(rows[0]['id'], rows[2]['metadata']['alertId'])  # recovery points at its alert
        self.assertEqual(rows[2]['metadata']['durationSeconds'], 5000)

    def test_lower_then_higher_again_is_an_escalation(self):
        r = make_round()
        step(r, [bad('q', 'critical')], 0)
        self.assertEqual(step(r, [bad('q', 'warning')], 300), [])
        self.assertEqual(step(r, [bad('q', 'critical')], 600), [('escalated', 'q', False)])

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
        text = monitor.compose(r, events)
        self.assertTrue(text.startswith('🟠 [演练] AllRice M1 Dev：1 项告警，1 项恢复'))
        self.assertIn('[警告] 磁盘余量不足', text)
        self.assertIn('   第一步：step', text)
        self.assertIn('手册：https://github.com/semiok/allrice/blob/main/docs/runbooks/x.md', text)
        self.assertIn('✅ 已恢复：坏了（持续 15 分钟）', text)

    def test_nothing_to_say(self):
        r = make_round()
        self.assertIsNone(monitor.compose(r, []))


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
        with mock.patch.object(monitor, 'send_telegram', side_effect=lambda cfg, text: sent.append(text)):
            self.assertTrue(monitor.deliver(r, 'c'))
        self.assertEqual(sent, ['a', 'b', 'c'])
        self.assertEqual(r.state['outbox'], [])

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


class Deploys(unittest.TestCase):
    def test_a_running_deploy_is_not_an_outage(self):
        r = make_round()
        owner = os.path.join(r.cfg['stateDir'], 'owner.json')
        inflight = os.path.join(r.cfg['stateDir'], 'inflight')
        r.cfg.update(deployLockOwner=owner, deployInflight=inflight)
        with open(owner, 'w') as f:
            json.dump({'pid': os.getpid(), 'startedAt': r.now - 60}, f)
        self.assertIsNone(monitor.check_web(r))  # stopped on purpose: not judged
        self.assertIsNone(monitor.check_postgres(r))
        os.mkdir(inflight)
        self.assertEqual(monitor.check_deploy(r)[0]['severity'], 'ok')
        r.facts.clear()
        r.now += 46 * 60  # past the grace period the deploy counts as stuck
        self.assertFalse(monitor.deploying(r))
        self.assertEqual(monitor.check_deploy(r)[0]['severity'], 'critical')
        r.facts.clear()
        with open(owner, 'w') as f:
            json.dump({'pid': 2 ** 22 + 12345, 'startedAt': r.now}, f)  # holder gone (killed)
        self.assertFalse(monitor.deploying(r))


class Peer(unittest.TestCase):
    def test_m1_side_judgement(self):
        r = make_round(peer=True)
        r.now = 10_000

        def remote(hb, err='', reachable=True):
            return mock.patch.object(monitor, 'read_remote_heartbeat', return_value=(hb, err, reachable))

        with remote(None, 'SSH 连不上 m1', False):
            self.assertEqual([(f['key'], f['severity']) for f in monitor.check_m1(r)], [('m1_reachable', 'critical')])
        fresh = {'at': 9_800, 'telegram': {'configured': True, 'pending': 0, 'lastOkAt': 9_000}, 'publicUrl': 'https://a.example'}
        with remote(fresh):
            self.assertEqual({f['key']: f['severity'] for f in monitor.check_m1(r)},
                             {'m1_reachable': 'ok', 'm1_heartbeat': 'ok', 'm1_telegram': 'ok'})
        self.assertEqual(r.state['m1PublicUrl'], 'https://a.example')
        with remote(dict(fresh, at=10_000 - 8 * 60)):
            self.assertEqual({f['key']: f['severity'] for f in monitor.check_m1(r)}['m1_heartbeat'], 'critical')
        with remote(dict(fresh, telegram={'configured': True, 'pending': 3, 'lastOkAt': 10_000 - 21 * 60})):
            self.assertEqual({f['key']: f['severity'] for f in monitor.check_m1(r)}['m1_telegram'], 'warning')
        with remote(dict(fresh, at=9_900, lastDoneAt=10_000 - 13 * 60)):  # rounds start but never finish
            self.assertEqual({f['key']: f['severity'] for f in monitor.check_m1(r)}['m1_heartbeat'], 'critical')
        with remote(None, '读不到 m1:allrice-dev/monitor/heartbeat.json'):
            self.assertEqual({f['key']: f['severity'] for f in monitor.check_m1(r)}['m1_heartbeat'], 'critical')


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


if __name__ == '__main__':
    unittest.main()
