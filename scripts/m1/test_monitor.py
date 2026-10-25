# Unit tests for scripts/m1/monitor (MET-222): the alert state machine, message
# composition, delivery backlog and the checks' judgement, with every system call stubbed.
#   python3 -m unittest discover -s scripts/m1 -p 'test_*.py'
import importlib.machinery
import importlib.util
import io
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
        self.assertEqual(step(r, [bad('t')], 2100), [('reminder', 't', False)])  # still bad on the next round: paged
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
        with self.remote(dict(fresh, at=10_000 - 8 * 60)):
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
        with self.remote(fresh, holders=['777']):
            monitor.check_m1(r)
        self.assertIsNone(monitor.check_outside(r))
        r.facts.clear()
        with self.remote(fresh, holders=[]), mock.patch.object(monitor, 'http_get', return_value=(200, b'ok')):
            monitor.check_m1(r)
            self.assertEqual(monitor.check_outside(r)[0]['severity'], 'ok')

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


if __name__ == '__main__':
    unittest.main()
