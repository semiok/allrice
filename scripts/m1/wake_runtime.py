"""Shared wait paths, identity and durable notification delivery. Python 3.9."""
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

QUEUE_DELAYS = (1, 2, 4)


def base():
    return Path.home() / 'allrice-dev'


def root():
    return base() / 'qa/wake-when'


def stamp():
    return datetime.now(timezone.utc).isoformat()


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.%s.tmp' % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    tmp.replace(path)


def read(path, default=None):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else default
    except (OSError, ValueError):
        return default


def threads():
    entries = []
    for line in (base() / 'wake-when.threads').read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        name, thread = line.rsplit(None, 1)
        if str(uuid.UUID(thread)) != thread or not name.strip():
            raise ValueError('invalid thread whitelist entry')
        entries.append((name, thread))
    if len(entries) != 7 or len({n for n, _ in entries}) != 7 or len({t for _, t in entries}) != 7:
        raise ValueError('thread whitelist must contain exactly seven distinct names and UUIDs')
    return {t: n for n, t in entries}


def boot_id():
    if sys.platform == 'darwin':
        return subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.boottime'], text=True, timeout=5).strip()
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def process_identity(pid):
    if type(pid) is not int or pid <= 0:
        return None
    proc = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=,stat='],
                          capture_output=True, text=True, timeout=5)
    parts = proc.stdout.strip().rsplit(None, 1)
    return parts[0] if proc.returncode == 0 and len(parts) == 2 and not parts[1].startswith('Z') else None


def pulse(run, state):
    save(run / 'heartbeat.json', dict(at=stamp(), pid=os.getpid(), boot=state['boot'],
                                     identity=state['identity'], phase=state.get('phase'),
                                     commandPid=state.get('commandPid')))


def load_tool(name):
    loader = importlib.machinery.SourceFileLoader('m1_' + name.replace('-', '_'), str(Path(__file__).with_name(name)))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def rollout_paths(allowed):
    found = {}
    for folder in ('sessions', 'archived_sessions'):
        for path in (Path.home() / '.codex' / folder).rglob('*.jsonl'):
            thread = path.stem[-36:]
            if thread in allowed:
                # An archived copy takes precedence: never wake an archived thread.
                old = found.get(thread)
                if old is None or folder == 'archived_sessions':
                    found[thread] = (folder, path)
    return found


def thread_problem(thread):
    try:
        allowed = threads()
    except (ValueError, OSError):
        return '白名单无效或不可读'
    if thread not in allowed:
        return '线程不在当前白名单'
    item = rollout_paths({thread}).get(thread)
    if item is None:
        return '线程不存在（没有 rollout）'
    if item[0] == 'archived_sessions':
        return '线程已归档'
    return None


def telegram(message):
    # The existing monitor transport alone reads its own Telegram configuration.
    # A subprocess bounds the entire proxy + direct attempt; never log exceptions
    # containing transport URLs or credential values.
    result = subprocess.run([sys.executable, str(Path(__file__).with_name('m1-dog')), '_telegram'],
                            input=message, text=True, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=50)
    return result.returncode == 0


def alert(directory, message, now=None):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / 'telegram.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return read(directory / 'telegram.json', {})
        return alert_locked(directory, message, now)
    finally:
        os.close(fd)


def alert_locked(directory, message, now=None):
    now = time.time() if now is None else now
    path = directory / 'telegram.json'
    state = read(path, {})
    if state.get('sentAt') or now < state.get('retryAt', 0):
        return state
    try:
        ok = telegram(message)
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    count = state.get('attempts', 0) + 1
    state.update(attempts=count, message=message, lastAttemptAt=stamp())
    if ok:
        state.update(sentAt=stamp(), unresolved=False)
    else:
        state.update(unresolved=True, retryAt=now + min(3600, 60 * 2 ** min(count, 6)))
    save(path, state)
    return state


def deliver(directory, thread, message, runner, now=None):
    """Only notifications are retried. A per-message flock arbitrates dog/supervisor."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / 'delivery.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return read(directory / 'delivery.json', {})
        state = read(directory / 'delivery.json', {})
        if state.get('sentAt'):
            return state
        state.update(thread=thread, message=message)
        state.setdefault('createdAt', stamp())
        issue = thread_problem(thread)
        if issue:
            state.update(status='escalated', reason=issue)
        elif state.get('status') != 'escalated':
            with (directory / 'notification.log').open('ab', buffering=0) as log:
                for attempt in range(state.get('attempts', 0), len(QUEUE_DELAYS) + 1):
                    # Recheck on every attempt, including after thread rotation.
                    issue = thread_problem(thread)
                    if issue:
                        state.update(status='escalated', reason=issue)
                        break
                    state.update(status='sending', attempts=attempt + 1, attemptedAt=stamp())
                    save(directory / 'delivery.json', state)
                    try:
                        code, timed_out = runner([str(Path.home() / '.local/bin/codex'), 'queue',
                                                 '--thread', thread, '--message', message], 30, log)
                    except Exception as error:
                        code, timed_out = 70, False
                        log.write((type(error).__name__ + '\n').encode())
                    state.update(queueExitCode=code, queueTimedOut=timed_out)
                    if code == 0:
                        state.update(status='sent', sentAt=stamp())
                        break
                    # Queue can reject a thread even when its local rollout remains.
                    tail = (directory / 'notification.log').read_bytes()[-8192:].decode(errors='replace').lower()
                    if any(s in tail for s in ('archived', 'thread not found', 'thread does not exist')):
                        state.update(status='escalated', reason='queue 拒绝目标线程')
                        break
                    save(directory / 'delivery.json', state)
                    if attempt < len(QUEUE_DELAYS):
                        time.sleep(QUEUE_DELAYS[attempt])
                if not state.get('sentAt'):
                    state.update(status='escalated', reason=state.get('reason', 'queue 重试耗尽或超时'))
        save(directory / 'delivery.json', state)
        if state.get('status') == 'escalated':
            alert(directory, 'M1-dog：%s；线程 %s；请人工核对。\n%s\n记录 %s' %
                  (state['reason'], thread, message[:600], directory), now)
        return state
    finally:
        # Keep this tiny shared inode: deleting a flock file while another sender
        # has it open can allow two concurrent senders. It holds no slot or process.
        os.close(fd)


def incident(key):
    return root() / 'dog/alerts' / hashlib.sha256(key.encode()).hexdigest()
