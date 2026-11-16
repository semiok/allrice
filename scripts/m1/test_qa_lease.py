import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('qa_lease', Path(__file__).with_name('qa-lease.py'))
lease = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(lease)


class LeaseSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.path = self.root / 'qa/occupant/instance.json'
        self.path.parent.mkdir(parents=True)
        self.data = {'owner': '占用线', 'card': 'MET-220', 'createdAt': lease.stamp(time.time() - 86400),
                     'expiresAt': lease.stamp(time.time() - 1), 'webPort': 3200, 'workerPort': 3201}
        lease.write(self.path, self.data)

    def test_legacy_is_never_automatically_expired(self):
        self.assertFalse(lease.expired({'updatedAt': lease.stamp(1)}))
        for value in ['0', '-1', '25h', '86401s', '6.5h', 'nan']:
            with self.assertRaises(ValueError):
                lease.seconds(value)
        self.assertEqual(lease.seconds('6h'), 21600)
        self.assertEqual(lease.seconds('24'), 86400)

    def test_loaded_unknown_listener_and_orphan_are_not_stopped(self):
        absent = subprocess.CompletedProcess([], 113, '', '')
        with patch.object(lease.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'state = waiting', '')):
            self.assertEqual(lease.process_state(self.path, self.data), 'loaded')
        with patch.object(lease.subprocess, 'run', return_value=subprocess.CompletedProcess([], 7, '', '')):
            self.assertEqual(lease.process_state(self.path, self.data), 'unknown')
        with patch.object(lease.subprocess, 'run', return_value=absent), patch.object(lease.socket, 'create_connection'):
            self.assertEqual(lease.process_state(self.path, self.data), 'running')
        orphan = subprocess.CompletedProcess([], 0, 'n' + str(self.path.parent / 'release') + '\n', '')
        with patch.object(lease.subprocess, 'run', side_effect=[absent, absent, orphan]), patch.object(lease.socket, 'create_connection', side_effect=ConnectionRefusedError):
            self.assertEqual(lease.process_state(self.path, self.data), 'running')
        with patch.object(lease.subprocess, 'run', return_value=absent), patch.object(lease.socket, 'create_connection', side_effect=TimeoutError):
            self.assertEqual(lease.process_state(self.path, self.data), 'unknown')

    def test_symlinked_logs_refuse_archive_without_leaving_partial_archive(self):
        (self.root / 'private').mkdir()
        (self.root / 'private/creds.log').write_text('SECRET')
        (self.path.parent / 'logs').symlink_to(self.root / 'private', target_is_directory=True)
        destination = self.root / 'archive'
        with self.assertRaises(ValueError):
            lease.archive(self.path, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertTrue(self.path.exists())

    def test_concurrent_waiters_share_throttle_and_message_contains_waiter_and_duration(self):
        calls = []

        def graphql(query, variables):
            calls.append(variables)
            return {'issue': {'id': 'issue-uuid'}} if 'query' in query else {'commentCreate': {'success': True}}

        with patch.object(lease, 'process_state', return_value='running'), patch.object(lease, 'graphql', side_effect=graphql):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(lease.remind, self.path, 'waiter-' + str(i), '等待线', 'MET-249', time.time() - 600) for i in range(2)]
                for future in futures:
                    future.result(timeout=5)
            self.assertEqual(len(calls), 2)
            body = calls[1]['input']['body']
            self.assertIn('等待线（MET-249）', body)
            self.assertIn('已等待 10m', body)
            self.assertIn('占用线（MET-220）', body)
            self.assertEqual(calls[1]['input']['issueId'], 'issue-uuid')
            marker = self.path.parent.parent / '.reminders/occupant.json'
            status = lease.read(marker)
            self.assertEqual(status['status'], 'sent')
            status['attemptedAt'] -= 1801
            lease.write(marker, status)
            lease.remind(self.path, 'later', '等待线', 'MET-249', time.time())
            self.assertEqual(len(calls), 4)

    def test_failed_notification_is_visible_and_not_retried_each_poll(self):
        with patch.object(lease, 'process_state', return_value='running'), patch.object(lease, 'graphql', side_effect=RuntimeError('SECRET')) as request:
            lease.remind(self.path, 'waiter', '等待线', 'MET-249', time.time())
            lease.remind(self.path, 'waiter', '等待线', 'MET-249', time.time())
            self.assertEqual(request.call_count, 1)
        marker = self.path.parent.parent / '.reminders/occupant.json'
        self.assertEqual(lease.read(marker)['status'], 'failed')
        self.assertNotIn('SECRET', marker.read_text())

    def test_fresh_and_stopped_occupants_do_not_receive_reminders(self):
        with patch.object(lease, 'process_state', return_value='stopped'), patch.object(lease, 'graphql') as request:
            lease.remind(self.path, 'waiter', '等待线', 'MET-249', time.time())
            request.assert_not_called()
        self.data['expiresAt'] = lease.stamp(time.time() + 600)
        lease.write(self.path, self.data)
        with patch.object(lease, 'process_state', return_value='running'), patch.object(lease, 'graphql') as request:
            lease.remind(self.path, 'waiter', '等待线', 'MET-249', time.time())
            request.assert_not_called()

    def test_linear_errors_are_not_success_even_with_http_200(self):
        import io
        with patch.dict(os.environ, LINEAR_API_KEY='test-only'), patch.object(lease.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"errors":[{"message":"denied"}]}')):
            with self.assertRaises(ValueError):
                lease.graphql('query', {})


if __name__ == '__main__':
    unittest.main()
