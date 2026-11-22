import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('workday', ROOT / 'run.py')
workday = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workday)


class RunnerTests(unittest.TestCase):
    def test_original_twenty_cases_and_full_user_journey_are_preserved(self):
        cases = json.loads((ROOT / 'cases.json').read_text())
        self.assertEqual(len(cases), 20)
        self.assertEqual({case['id'] for case in cases}, {step[1] for step in workday.STEPS})
        for step in ['VM.cold', 'VM.warm', 'VM.idle-continue', 'RECOVERY.cold-history',
                     'SUBAGENT.deny-write', 'SCHEDULE.native', 'ADMIN.usage', 'ADMIN.approvals']:
            self.assertIn(step, {row[0] for row in workday.STEPS})

    def test_fixture_executes_bytes_but_cannot_pass_a_dev_workday_or_replace_first_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'run'
            with patch.object(workday, 'native_fixture', side_effect=workday.Unavailable('273 producer unavailable')):
                self.assertEqual(workday.run('fixture', output, {}), 2)
            receipt = json.loads((output / 'result.json').read_text())
            self.assertGreater(receipt['summary']['fixturePassed'], 0)
            self.assertEqual(receipt['summary']['devPassed'], 0)
            self.assertGreater(receipt['summary']['counts']['skipped'], 0)
            self.assertFalse(receipt['summary']['completeWorkday'])
            self.assertFalse(receipt['summary']['acceptanceGranted'])
            self.assertIn('273 producer unavailable', (output / 'index.html').read_text())
            self.assertEqual(workday.sha(output / 'fixtures/source.txt'),
                             json.loads((output / 'fixture-hashes.json').read_text())['source.txt'])
            original = (output / 'result.json').read_bytes()
            with self.assertRaises(FileExistsError):
                workday.run('fixture', output, {})
            self.assertEqual((output / 'result.json').read_bytes(), original)

    def test_skip_and_fixture_pass_are_never_an_aggregate_pass(self):
        fixture = workday.result('a', 'CHAT', 'fixture', 'passed', 'fixture', 'executed', '273')
        skipped = workday.result('b', 'VM', 'missing', 'skipped', 'dev', 'cap unavailable', '267')
        for rows in ([fixture], [skipped], [fixture, skipped]):
            self.assertEqual(workday.summarize(rows)['exitCode'], 2)
            self.assertFalse(workday.summarize(rows)['completeWorkday'])
        failed = workday.result('c', 'CHAT', 'failure', 'failed', 'fixture', 'actual failure', '273')
        self.assertEqual(workday.summarize([fixture, skipped, failed])['exitCode'], 1)

    def test_report_html_escapes_untrusted_text_and_has_no_synthetic_screenshot(self):
        evil = '<script>alert("credential")</script>'
        step = workday.result('x', 'VM', evil, 'skipped', 'dev', evil, evil, [evil])
        receipt = {'mode': evil, 'releaseSha': evil, 'summary': {}, 'steps': [step]}
        rendered = workday.render(receipt)
        self.assertNotIn('<script>', rendered)
        self.assertIn('&lt;script&gt;', rendered)
        self.assertNotIn('<img', rendered)
        step['screenshot'] = 'javascript:alert(1)'
        rendered = workday.render(receipt)
        self.assertNotIn('href="javascript:', rendered)
        self.assertNotIn('<img', rendered)

    def test_secrets_are_scrubbed_recursively_and_in_errors(self):
        secret = 'explicit-private-session'
        value = {'cookie': secret, 'nested': [{'accessToken': 'other-secret'}],
                 'message': secret + ' Bearer third-secret password=fourth-secret'}
        encoded = json.dumps(workday.scrub(value, [secret]))
        for forbidden in [secret, 'other-secret', 'third-secret', 'fourth-secret']:
            self.assertNotIn(forbidden, encoded)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'run'
            with patch.dict(os.environ, {workday.SESSION_ENV: secret}), patch.object(
                    workday, 'native_fixture', side_effect=RuntimeError('driver Cookie: ' + secret)):
                self.assertEqual(workday.run('fixture', output, {}), 1)
            for name in ['index.html', 'result.json']:
                self.assertNotIn(secret, (output / name).read_text())

    def live_config(self):
        return dict(baseUrl='https://explicit-test.invalid',
                    personId='11111111-1111-4111-8111-111111111111',
                    organizationId='22222222-2222-4222-8222-222222222222',
                    workspaceId='33333333-3333-4333-8333-333333333333',
                    employeeInstanceId='44444444-4444-4444-8444-444444444444',
                    threadId='55555555-5555-4555-8555-555555555555',
                    releaseSha='a' * 40, requestTimeoutSeconds=1,
                    gates={key: 'explicit-evidence-ref' for key in
                           ['met267', 'node4', 'deployment', 'personalRollout', 'readAuthorization']})

    def test_dev_requires_actual_scope_session_gate_evidence_and_never_networks_without_them(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(workday, 'dev_json') as request:
            self.assertEqual(workday.run('dev', Path(temp) / 'run', {}), 2)
            request.assert_not_called()
        config = self.live_config()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(workday.Unavailable):
                workday.validate_live(config)
        with patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic'}):
            config['baseUrl'] = 'https://user:password@explicit-test.invalid'
            with self.assertRaises(ValueError):
                workday.validate_live(config)
            config = self.live_config()
            del config['gates']['met267']
            with self.assertRaises(workday.Unavailable):
                workday.validate_live(config)

    def test_legacy_generation_and_wrong_person_are_not_4_acceptance(self):
        config = self.live_config()
        identity = {key: config[key] for key in ['personId', 'organizationId', 'workspaceId', 'employeeInstanceId', 'threadId']}
        identity.update(employeeRevision=1, employeeVersionId='66666666-6666-4666-8666-666666666666')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic'}):
            output = Path(temp)
            with patch.object(workday, 'dev_json', side_effect=[{'identity': identity},
                    {'mount': {'identity': identity, 'executionGeneration': '3.x', 'bindingRef': 'old'}}]):
                with self.assertRaises(workday.Unavailable):
                    workday.dev_identity(config, output)
            with patch.object(workday, 'dev_json', return_value={'identity': {**identity, 'personId': 'another-person'}}):
                with self.assertRaises(ValueError):
                    workday.dev_identity(config, output)
            self.assertFalse((output / 'dev-identity.json').exists())

    def test_control_ready_is_discovery_only_and_does_not_claim_editor_or_model(self):
        config = self.live_config()
        identity = {key: config[key] for key in ['personId', 'organizationId', 'workspaceId', 'employeeInstanceId', 'threadId']}
        identity.update(employeeRevision=1, employeeVersionId='66666666-6666-4666-8666-666666666666')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic'}), patch.object(
                workday, 'dev_json', side_effect=[{'identity': identity}, {'mount': {
                    'identity': identity, 'executionGeneration': '4.0', 'bindingRef': 'actual'}, 'controlReady': True}]):
            rows = workday.dev_identity(config, Path(temp))
            self.assertEqual(len(rows), 2)
            evidence = json.loads((Path(temp) / 'dev-identity.json').read_text())
            self.assertEqual(evidence['editorReady'], 'not-verified')
            self.assertEqual(evidence['canSend'], 'not-verified')

    def test_unexpected_identity_fields_are_rejected_without_persisting_secret_body(self):
        config = self.live_config()
        identity = {key: config[key] for key in ['personId', 'organizationId', 'workspaceId', 'employeeInstanceId', 'threadId']}
        identity.update(employeeRevision=1, employeeVersionId='66666666-6666-4666-8666-666666666666',
                        accessToken='must-not-persist')
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic'}), patch.object(
                workday, 'dev_json', return_value={'identity': identity}):
            with self.assertRaises(ValueError):
                workday.dev_identity(config, Path(temp))
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_bad_source_is_skipped_not_a_fake_native_fixture_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(workday.Unavailable):
                workday.native_fixture({'fixtureSource': temp}, Path(temp))
            (Path(temp) / workday.FIXTURE_FILE).parent.mkdir(parents=True)
            (Path(temp) / workday.FIXTURE_FILE).write_text('// not a source receipt')
            with patch.object(subprocess, 'check_output', return_value='b' * 40):
                with self.assertRaises(ValueError):
                    workday.native_fixture({'fixtureSource': temp, 'fixtureSha': 'a' * 40}, Path(temp))

    def test_live_ui_writes_unknown_routes_and_fake_screenshots_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            for ui in [{'MEMORY.write': {}}, {'ADMIN.usage': {'ownerSource': 'owner', 'path': '//external', 'locator': 'body', 'scopeLocator': 'body', 'scopeAttribute': 'data-owned'}}]:
                with self.assertRaises(ValueError):
                    workday.browser_reads({'ui': ui}, Path(temp))

    def test_claimed_ui_pass_requires_a_real_png_in_the_owned_evidence_directory(self):
        config = self.live_config()
        config.update(browserExecutable=sys.executable, ui={'MEMORY.read': {
            'ownerSource': 'synthetic-test-source', 'path': '/fixture-only',
            'locator': 'fixture', 'scopeLocator': 'fixture', 'scopeAttribute': 'fixture-id'}})
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic'}):
            root = Path(temp)
            (root / 'apps/worker/node_modules/playwright-core').mkdir(parents=True)
            workday.write_json(root / 'dev-identity.json', {'bindingRef': 'synthetic-test-only'})
            (root / 'fake.png').write_text('<svg>not a screenshot</svg>')
            for filename in ['../outside.png', 'fake.png']:
                workday.write_json(root / 'browser.json', {'closed': True, 'steps': {
                    'MEMORY.read': {'status': 'passed', 'screenshot': filename, 'reason': 'claimed'}}})
                with patch.object(workday, 'REPO', root), patch.object(workday, 'child', return_value=0):
                    with self.assertRaises(ValueError):
                        workday.browser_reads(config, root)

    def test_native_close_receipt_failure_cannot_become_a_fixture_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            fixture = source / workday.FIXTURE_FILE
            fixture.parent.mkdir(parents=True)
            fixture.write_text('synthetic parser test, never imported')
            (root / 'node_modules/vitest').mkdir(parents=True)
            (root / 'node_modules/vitest/vitest.mjs').write_text('')
            workday.write_json(root / 'native-fixture.json', {'kind': 'consumer-fixture', 'closed': False, 'steps': []})
            def git(args, **kwargs):
                return fixture.read_bytes() if args[-1].endswith(workday.FIXTURE_FILE) else workday.FIXTURE_SHA
            with patch.object(workday, 'REPO', root), patch.object(subprocess, 'check_output', side_effect=git), patch.object(
                    subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), patch.object(workday, 'child', return_value=0):
                with self.assertRaises(ValueError):
                    workday.native_fixture({'fixtureSource': str(source)}, root)

    def test_interrupted_owned_child_is_joined_and_failure_is_not_success(self):
        class Interrupted:
            pid = 12345
            calls = 0
            def communicate(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise KeyboardInterrupt()
                return ('', '')
        process = Interrupted()
        with tempfile.TemporaryDirectory() as temp, patch.object(subprocess, 'Popen', return_value=process), patch.object(os, 'killpg') as kill:
            with self.assertRaises(KeyboardInterrupt):
                workday.child(['fixture-only'], Path(temp), {}, {
                    'driverTimeoutSeconds': 1, 'cleanupTimeoutSeconds': 1})
            self.assertEqual(process.calls, 2)
            kill.assert_called_once_with(process.pid, workday.signal.SIGTERM)

    def test_explicit_cleanup_budget_joins_a_stubborn_owned_child_after_kill(self):
        class Stubborn:
            pid = 12345
            calls = 0
            def communicate(self, *args, **kwargs):
                self.calls += 1
                if self.calls <= 2:
                    raise subprocess.TimeoutExpired('owned-test-only', 1)
                return ('', '')
        process = Stubborn()
        with tempfile.TemporaryDirectory() as temp, patch.object(subprocess, 'Popen', return_value=process), patch.object(os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                workday.child(['fixture-only'], Path(temp), {}, {
                    'driverTimeoutSeconds': 1, 'cleanupTimeoutSeconds': 1})
            self.assertEqual(process.calls, 3)
            self.assertEqual([call.args[1] for call in kill.call_args_list],
                             [workday.signal.SIGTERM, workday.signal.SIGKILL])

    def test_child_nonzero_exit_and_logs_remain_failure_and_redacted(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {workday.SESSION_ENV: 'synthetic-private-token'}):
            code = workday.child([sys.executable, '-c',
                                  'import sys; print("Bearer synthetic-private-token"); sys.exit(7)'],
                                 Path(temp), workday.process_env(), {
                                     'driverTimeoutSeconds': 5, 'cleanupTimeoutSeconds': 5})
            self.assertEqual(code, 7)
            self.assertNotIn('synthetic-private-token', (Path(temp) / 'driver.log').read_text())

    def test_cli_incomplete_exit_and_report_survive_driver_exception(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'run'
            completed = subprocess.run([sys.executable, str(ROOT / 'run.py'), '--mode', 'fixture',
                                        '--output', str(output)], capture_output=True, text=True)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertTrue((output / 'index.html').is_file())
            self.assertFalse(json.loads(completed.stdout)['completeWorkday'])
            self.assertNotIn('allrice_session=', (output / 'result.json').read_text())


if __name__ == '__main__':
    unittest.main()
