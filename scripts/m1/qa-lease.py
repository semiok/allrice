#!/usr/bin/env python3
"""QA lease metadata, conservative process checks and waiter notifications.

The shell holds the allocation/task locks for all metadata mutations. Reminders
have a separate cross-waiter lock and never hold the allocation lock over HTTP.
"""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

FIELDS = ('task ref sha webPort workerPort database nativeArtifactId cloudExecution '
          'setup updatedAt owner card createdAt expiresAt').split()


def stamp(now=None):
    return dt.datetime.fromtimestamp(time.time() if now is None else now, dt.timezone.utc).isoformat()


def seconds(value):
    match = re.fullmatch(r'([1-9][0-9]*)([smh]?)', value)
    if not match:
        raise ValueError('ttl must be positive hours (6 or 6h), minutes (30m), or seconds (60s)')
    result = int(match[1]) * {'': 3600, 'h': 3600, 'm': 60, 's': 1}[match[2]]
    if result > 86400:
        raise ValueError('ttl must not exceed 24h')
    return result


def epoch(value):
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError('lease timestamps must have a timezone')
    return parsed.timestamp()


def write(path, data):
    path = Path(path)
    fd, temp = tempfile.mkstemp(prefix='.lease-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def read(path):
    return json.loads(Path(path).read_text())


def expired(data):
    # Legacy instances have no lease: never guess permission to delete them.
    return bool(data.get('expiresAt')) and epoch(data['expiresAt']) <= time.time()


def duration(start):
    return '%dm' % max(0, (time.time() - start) // 60)


def process_state(path, data):
    """Unknown/loaded jobs and orphan processes are not safe to reclaim."""
    for role in ('web', 'worker'):
        job = 'gui/%s/ai.bplabs.allrice-qa-%s-%s' % (os.getuid(), path.parent.name, role)
        result = subprocess.run(['launchctl', 'print', job], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            return 'running' if re.search(r'^\s*pid = [1-9][0-9]*$', result.stdout, re.M) else 'loaded'
        if result.returncode != 113:
            return 'unknown'
        try:
            with socket.create_connection(('127.0.0.1', int(data[role + 'Port'])), timeout=.2):
                return 'running'
        except ConnectionRefusedError:
            pass
        except OSError:
            return 'unknown'
    # A detached process may run elsewhere but still use this release or files.
    # Inspect paths, not process environments (which can contain credentials).
    result = subprocess.run(['ps', '-xww', '-U', str(os.getuid()), '-o', 'pid=,ppid=,command='],
                            capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return 'unknown'
    processes = {}
    for line in result.stdout.splitlines():
        pid, parent, command = line.strip().split(None, 2)
        processes[int(pid)] = (int(parent), command)
    ancestors, pid = set(), os.getpid()
    while pid and pid not in ancestors:
        ancestors.add(pid)
        pid = processes.get(pid, (0, ''))[0]
    prefixes = {str(path.parent.absolute()), str(path.parent.resolve())}
    def refers(value):
        return any(value == prefix or value.startswith(prefix + '/') for prefix in prefixes)
    if any(pid not in ancestors and any(prefix + '/' in command for prefix in prefixes)
           for pid, (_, command) in processes.items()):
        return 'running'
    result = subprocess.run(['lsof', '-nP', '-a', '-u', str(os.getuid()), '-Fpn'],
                            capture_output=True, text=True, timeout=5)
    if result.returncode != 0:
        return 'unknown'
    pid = None
    for line in result.stdout.splitlines():
        if line.startswith('p'):
            pid = int(line[1:])
        elif line.startswith('n') and pid not in ancestors and refers(line[1:]):
            return 'running'
    return 'stopped'


def describe(path):
    data = read(path)
    state = process_state(path, data)
    created = epoch(data['createdAt']) if data.get('createdAt') else path.stat().st_mtime
    lease = 'expired' if expired(data) else ('leased' if data.get('expiresAt') else 'legacy')
    return data, state, '%s owner=%s card=%s age=%s process=%s lease=%s' % (
        path.parent.name, data.get('owner', '?'), data.get('card', '?'), duration(created), state, lease)


def archive(path, destination):
    # An explicit allowlist: no .env, creds.json, plists, storage or symlinks.
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError('refusing symlinked instance')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    name = path.parent.name + '-' + uuid.uuid4().hex
    pending = Path(tempfile.mkdtemp(prefix='.pending-', dir=destination))
    try:
        data = read(path)
        write(pending / 'instance.json', {k: data[k] for k in FIELDS if k in data})
        logs = path.parent / 'logs'
        if logs.is_symlink():
            raise ValueError('refusing symlinked logs')
        (pending / 'logs').mkdir(mode=0o700)
        if logs.exists():
            def unreadable(error):
                raise error
            for root, dirs, files in os.walk(logs, followlinks=False, onerror=unreadable):
                dirs[:] = [d for d in dirs if not (Path(root) / d).is_symlink()]
                for filename in files:
                    source = Path(root) / filename
                    if not filename.endswith('.log') or not stat.S_ISREG(source.lstat().st_mode):
                        continue
                    target = pending / 'logs' / source.relative_to(logs)
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    shutil.copyfile(source, target, follow_symlinks=False)
                    target.chmod(0o600)
        target = destination / name
        pending.rename(target)
        return target
    finally:
        if pending.exists():
            shutil.rmtree(pending)


def graphql(query, variables):
    key = os.environ.get('LINEAR_API_KEY')
    if not key:
        raise ValueError('up --wait reminders require LINEAR_API_KEY injected into this process')
    request = urllib.request.Request('https://api.linear.app/graphql',
                                     data=json.dumps({'query': query, 'variables': variables}).encode(),
                                     headers={'Content-Type': 'application/json', 'Authorization': key})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = json.load(response)
    if data.get('errors') or not data.get('data'):
        raise ValueError('Linear did not confirm the request')
    return data['data']


def remind(path, waiter, owner, card, started):
    # One durable reservation per instance generation; failures are visible and
    # throttled too, since a timeout may have happened after Linear committed.
    directory = path.parent.parent / '.reminders'
    directory.mkdir(exist_ok=True, mode=0o700)
    with (directory / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.exists():
            return
        data, state, summary = describe(path)
        if not expired(data) or state == 'stopped':
            return
        if not data.get('owner') or not re.fullmatch(r'[A-Z][A-Z0-9]*-[1-9][0-9]*', data.get('card', '')):
            raise ValueError('expired occupant lacks owner/card; cannot address a reminder')
        marker = directory / (path.parent.name + '.json')
        previous = read(marker) if marker.exists() else {}
        generation = data.get('createdAt')
        now = time.time()
        if previous.get('generation') == generation and now - previous.get('attemptedAt', 0) < 1800:
            return
        status = {'generation': generation, 'attemptedAt': now, 'status': 'pending', 'card': data['card']}
        write(marker, status)
        body = ('[QA名额提醒] %s（%s）正在等实例 %s，已等待 %s。\n\n'
                '占用方：%s（%s）；%s。租期已超但服务仍在跑或状态未确认，未自动停止；'
                '请用完后 down，需要继续使用请说明原因并 renew（最长24h）。') % (
                    owner, card, waiter, duration(float(started)), data['owner'], data['card'], summary)
        try:
            issue = graphql('query($id:String!){issue(id:$id){id}}', {'id': data['card']})['issue']['id']
            result = graphql('mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',
                             {'input': {'issueId': issue, 'body': body}})
            if result.get('commentCreate', {}).get('success') is not True:
                raise ValueError('Linear did not confirm the comment')
            status['status'] = 'sent'
            print('reminded %s on %s' % (data['owner'], data['card']), file=sys.stderr)
        except Exception:
            status['status'] = 'failed'
            print('qa-instance: reminder failed for %s; see %s; retry no sooner than 30m' %
                  (data['card'], marker), file=sys.stderr)
        write(marker, status)


def main(args):
    command, *args = args
    if command == 'ttl':
        print(seconds(args[0]))
        return
    path = Path(args[0])
    if command == 'list':
        for f in sorted(path.glob('*/instance.json')):
            try:
                print(describe(f)[2])
            except (OSError, ValueError, subprocess.SubprocessError):
                print('%s process=unknown lease=invalid' % f.parent.name)
        return
    if command == 'remind':
        for f in sorted(path.glob('*/instance.json')):
            remind(f, *args[1:])
        return
    data = read(path)
    if command == 'renew':
        if not data.get('createdAt') or not data.get('owner') or not data.get('card'):
            raise ValueError('legacy instance: down then up with owner/card to adopt a lease')
        data.update(expiresAt=stamp(time.time() + seconds(args[1])), updatedAt=stamp())
        write(path, data)
        print('renewed %s until %s' % (path.parent.name, data['expiresAt']))
    elif command == 'reclaimable':
        sys.exit(0 if expired(data) and process_state(path, data) == 'stopped' else 1)
    elif command == 'archive':
        print(archive(path, Path(args[1])))
    else:
        raise ValueError('unknown lease command')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        # Do not print HTTP responses, credentials, or arbitrary exception data.
        print('qa-instance lease: %s' % (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(2)
