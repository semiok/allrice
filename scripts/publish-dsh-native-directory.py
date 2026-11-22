"""Host-only, one-shot readonly code publisher. No guest execution or subprocesses.
The JS release gate supplies trusted locks on stdin; CLI/env cannot change them.
Cancellation is cooperative; the caller must await this process's actual close.
"""
import fcntl
import hashlib
import json
import os
import posixpath
import re
import signal
import stat
import sys
import tarfile
import uuid

BASE = 'docker.io/library/node@sha256:af0bb4bf5b7318e3269417a7684a9e116c3c22eaf05382578b0d0d33de597ad2'
BINS = frozenset(('anthropic-ai-sdk cordis crc32 dsh dsoffice is-docker '
                  'is-inside-container js-yaml node-which pi-ai playwright '
                  'playwright-core semver which-command xlsx yaml').split())
RD = os.O_RDONLY | os.O_NOFOLLOW
DIR = RD | os.O_DIRECTORY
CANCELLED = False


def cancel(_signal, _frame):
    global CANCELLED
    CANCELLED = True  # Further TERM/INT never interrupts rollback.


def check():
    if CANCELLED:
        raise RuntimeError('DSH_IMAGE_CANCELLED')


def secure_dir(path, create=False):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise RuntimeError('DSH_IMAGE_HOST_PATH')
    if create:
        os.makedirs(path, mode=0o700, exist_ok=True)
    if os.path.realpath(path) != path:
        raise RuntimeError('DSH_IMAGE_HOST_PATH')
    fd = os.open(path, DIR)
    s = os.fstat(fd)
    if s.st_uid != os.getuid() or s.st_mode & 0o022:
        os.close(fd)
        raise RuntimeError('DSH_IMAGE_HOST_PERMISSIONS')
    return fd


def locked_file(path, size, digest, contents=False):
    fd = os.open(path, RD)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_size != size:
            raise RuntimeError('DSH_IMAGE_INPUT_SIZE_MISMATCH')
        h, count, chunks = hashlib.sha256(), 0, []
        while True:
            check()
            data = os.read(fd, 65536)
            if not data:
                break
            h.update(data)
            count += len(data)
            if count > size:
                raise RuntimeError('DSH_IMAGE_INPUT_SIZE_MISMATCH')
            if contents:
                chunks.append(data)
        if count != size or h.hexdigest() != digest:
            raise RuntimeError('DSH_IMAGE_INPUT_DIGEST_MISMATCH')
        if contents:
            raw = b''.join(chunks)
            os.close(fd)
            return raw
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except BaseException:
        os.close(fd)
        raise


def path_ok(path):
    return (isinstance(path, str) and path and '\0' not in path and '\\' not in path
            and not path.startswith('/') and all(p not in ('', '.', '..') for p in path.split('/')))


def members(manifest):
    entries = {}
    for e in manifest['files']:
        path, kind = e['path'], e['kind']
        if not path_ok(path) or path in entries or kind not in ('file', 'directory', 'symlink'):
            raise RuntimeError('DSH_IMAGE_MEMBER_INVALID')
        if not isinstance(e['mode'], int) or not 0 <= e['mode'] <= 0o777 or e['mode'] & 0o6000:
            raise RuntimeError('DSH_IMAGE_MEMBER_MODE_FORBIDDEN')
        entries[path] = e
    links = {p: e['target'] for p, e in entries.items() if e['kind'] == 'symlink'}
    if set(links) != {'node_modules/.bin/' + name for name in BINS}:
        raise RuntimeError('DSH_IMAGE_SYMLINK_FORBIDDEN')
    for path, e in entries.items():
        parent = posixpath.dirname(path)
        while parent:
            if entries.get(parent, {}).get('kind') != 'directory':
                raise RuntimeError('DSH_IMAGE_MEMBER_PARENT_INVALID')
            parent = posixpath.dirname(parent)
        if e['kind'] == 'symlink':
            target = links[path]
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            if (not target or target.startswith('/') or '\0' in target or '\\' in target
                    or resolved.startswith('../') or entries.get(resolved, {}).get('kind') != 'file'):
                raise RuntimeError('DSH_IMAGE_SYMLINK_FORBIDDEN')
    return entries


def parent_fd(root, path):
    fd = os.dup(root)
    try:
        for part in path.split('/')[:-1]:
            nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def write_new(fd, name, data, mode=0o600):
    child = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=fd)
    try:
        with os.fdopen(child, 'wb', closefd=False) as out:
            out.write(data)
            out.flush()
        os.fchmod(child, mode)
        os.fsync(child)
    finally:
        os.close(child)


def tree_hash(records):
    records.sort(key=lambda row: row[0].encode('utf8'))
    return hashlib.sha256(json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf8')).hexdigest()


def expected_tree(entries):
    rows = [['.', 'directory', 0o555]]
    for path, e in entries.items():
        if e['kind'] == 'directory':
            rows.append([path, 'directory', 0o555])
        elif e['kind'] == 'symlink':
            rows.append([path, 'symlink', e['target']])
        else:
            rows.append([path, 'file', 0o444, e['bytes'], e['sha256']])
    return tree_hash(rows)


def verify_tree(root, entries):
    # One publication-time content pass. Runtime trusts the sealed release receipt.
    rs = os.fstat(root)
    if rs.st_uid != os.getuid() or stat.S_IMODE(rs.st_mode) != 0o555:
        raise RuntimeError('DSH_IMAGE_TREE_ROOT')
    found, rows = set(), [['.', 'directory', 0o555]]
    def walk(fd, prefix=''):
        for name in os.listdir(fd):
            check()
            path = prefix + name
            e = entries.get(path)
            if e is None:
                raise RuntimeError('DSH_IMAGE_TREE_EXTRA')
            found.add(path)
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if s.st_uid != os.getuid():
                raise RuntimeError('DSH_IMAGE_TREE_OWNER')
            if e['kind'] == 'symlink':
                target = os.readlink(name, dir_fd=fd) if stat.S_ISLNK(s.st_mode) else None
                if target != e['target']:
                    raise RuntimeError('DSH_IMAGE_TREE_LINK')
                rows.append([path, 'symlink', target])
                continue
            mode = 0o555 if e['kind'] == 'directory' else 0o444
            if stat.S_IMODE(s.st_mode) != mode:
                raise RuntimeError('DSH_IMAGE_TREE_MODE')
            child = os.open(name, DIR if e['kind'] == 'directory' else RD, dir_fd=fd)
            try:
                if e['kind'] == 'directory':
                    rows.append([path, 'directory', mode])
                    walk(child, path + '/')
                else:
                    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                        raise RuntimeError('DSH_IMAGE_TREE_FILE')
                    h, count = hashlib.sha256(), 0
                    while True:
                        check()
                        data = os.read(child, 65536)
                        if not data:
                            break
                        count += len(data)
                        h.update(data)
                    actual = h.hexdigest()
                    if count != e['bytes'] or actual != e['sha256']:
                        raise RuntimeError('DSH_IMAGE_TREE_DIGEST')
                    rows.append([path, 'file', mode, count, actual])
            finally:
                os.close(child)
    walk(root)
    if found != set(entries):
        raise RuntimeError('DSH_IMAGE_TREE_MISSING')
    return tree_hash(rows)


def match_metadata(parent, name, expected):
    fd = os.open(name, RD, dir_fd=parent)
    try:
        s = os.fstat(fd)
        if (not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid()
                or stat.S_IMODE(s.st_mode) != 0o444 or s.st_size != len(expected)):
            raise RuntimeError('DSH_IMAGE_RELEASE_MISMATCH')
        with os.fdopen(os.dup(fd), 'rb') as source:
            if source.read(len(expected) + 1) != expected:
                raise RuntimeError('DSH_IMAGE_RELEASE_MISMATCH')
    finally:
        os.close(fd)


def remove_own(parent, name, identity):
    fd = os.open(name, DIR, dir_fd=parent)
    try:
        s = os.fstat(fd)
        if [str(s.st_dev), str(s.st_ino)] != identity or s.st_uid != os.getuid():
            raise RuntimeError('DSH_IMAGE_STAGE_UNKNOWN')
        os.fchmod(fd, 0o700)
        for entry in os.listdir(fd):
            s = os.stat(entry, dir_fd=fd, follow_symlinks=False)
            if s.st_uid != os.getuid():
                raise RuntimeError('DSH_IMAGE_STAGE_UNKNOWN')
            if stat.S_ISDIR(s.st_mode):
                remove_own(fd, entry, [str(s.st_dev), str(s.st_ino)])
            elif stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode):
                os.unlink(entry, dir_fd=fd)
            else:
                raise RuntimeError('DSH_IMAGE_STAGE_UNKNOWN')
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if [str(current.st_dev), str(current.st_ino)] != identity:
            raise RuntimeError('DSH_IMAGE_STAGE_UNKNOWN')
        os.rmdir(name, dir_fd=parent)
    finally:
        os.close(fd)


def publish(request):
    locks = request['locks']
    raw = locked_file(request['manifest'], locks['manifestBytes'], locks['manifestSha256'], contents=True)
    manifest = json.loads(raw)
    if (manifest['platform'] != 'linux-arm64-gnu' or manifest['containsAuthFiles'] is not False
            or manifest['archive']['sha256'] != locks['archiveSha256']
            or manifest['archive']['bytes'] != locks['archiveBytes']):
        raise RuntimeError('DSH_IMAGE_MANIFEST_LOCK_MISMATCH')
    entries = members(manifest)
    if (entries['node_modules/@deepseek-ai/dsh/lib/bin.js']['sha256'] != locks['cliSha256']
            or entries['package-lock.json']['sha256'] != locks['packageLockSha256']):
        raise RuntimeError('DSH_IMAGE_CODE_PIN_MISMATCH')
    archive = locked_file(request['archive'], locks['archiveBytes'], locks['archiveSha256'])
    parent = secure_dir(request['parent'], True)
    lock = os.open('.publish.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    stage, identity, renamed = None, None, False
    try:
        ls = os.fstat(lock)
        if not stat.S_ISREG(ls.st_mode) or ls.st_uid != os.getuid() or ls.st_nlink != 1 or stat.S_IMODE(ls.st_mode) != 0o600:
            raise RuntimeError('DSH_IMAGE_LOCK_UNKNOWN')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check()
        final = locks['archiveSha256']
        host = os.path.join(request['parent'], final, 'public')
        guest = '/opt/allrice/dsh/' + final
        tree_sha256 = expected_tree(entries)
        with open(__file__, 'rb') as publisher_source:
            publisher_sha256 = hashlib.sha256(publisher_source.read()).hexdigest()
        descriptor = dict(kind='allrice-dsh-readonly-directory-v2', artifactSha256=final,
                          archiveBytes=locks['archiveBytes'], manifestSha256=locks['manifestSha256'],
                          manifestBytes=locks['manifestBytes'], baseImage=BASE, hostDirectory=host,
                          guestDirectory=guest, dshVersion='0.2.1-rc.2', nodeVersion='22.23.2',
                          publisherSha256=publisher_sha256, gateSha256=request['gateSha256'],
                          treeSha256=tree_sha256)
        sealed = json.dumps(descriptor, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        sealed_sha256 = hashlib.sha256(sealed).hexdigest()
        try:
            existing = os.open(final, DIR, dir_fd=parent)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            try:
                s = os.fstat(existing)
                if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o555:
                    raise RuntimeError('DSH_IMAGE_RELEASE_MISMATCH')
                match_metadata(existing, 'descriptor.json', sealed)
                match_metadata(existing, 'manifest.json', raw)
                public = os.open('public', DIR, dir_fd=existing)
                try:
                    s = os.fstat(public)
                    if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o555:
                        raise RuntimeError('DSH_IMAGE_TREE_ROOT')
                finally:
                    os.close(public)
            finally:
                os.close(existing)
        else:
            stage = '.' + final + '.stage-' + str(uuid.uuid4())
            os.mkdir(stage, 0o700, dir_fd=parent)
            root_stage = os.open(stage, DIR, dir_fd=parent)
            identity = [str(os.fstat(root_stage).st_dev), str(os.fstat(root_stage).st_ino)]
            try:
                os.mkdir('public', 0o700, dir_fd=root_stage)
                root = os.open('public', DIR, dir_fd=root_stage)
                try:
                    for path, e in sorted(entries.items(), key=lambda item: item[0].count('/')):
                        check()
                        if e['kind'] != 'directory':
                            continue
                        fd = parent_fd(root, path)
                        try:
                            os.mkdir(posixpath.basename(path), 0o700, dir_fd=fd)
                        finally:
                            os.close(fd)
                    seen = set()
                    with os.fdopen(os.dup(archive), 'rb') as source, tarfile.open(fileobj=source, mode='r|') as tar:
                        for item in tar:
                            check()
                            name = item.name[2:] if item.name.startswith('./') else item.name
                            if item.isdir():
                                name = name.rstrip('/')
                            e = entries.get(name)
                            kind = 'directory' if item.isdir() else 'symlink' if item.issym() else 'file' if item.isreg() else None
                            if (e is None or name in seen or kind != e['kind'] or item.mode != e['mode']
                                    or item.sparse is not None or item.mode & 0o6000
                                    or (kind == 'file' and item.size != e['bytes'])
                                    or (kind == 'symlink' and item.linkname != e['target'])):
                                raise RuntimeError('DSH_IMAGE_TAR_MISMATCH')
                            seen.add(name)
                            if kind != 'file':
                                continue
                            fd = parent_fd(root, name)
                            try:
                                out = os.open(posixpath.basename(name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                                try:
                                    size = 0
                                    with tar.extractfile(item) as src, os.fdopen(out, 'wb', closefd=False) as dst:
                                        while True:
                                            check()
                                            data = src.read(65536)
                                            if not data:
                                                break
                                            size += len(data)
                                            dst.write(data)
                                        dst.flush()
                                    if size != e['bytes']:
                                        raise RuntimeError('DSH_IMAGE_TAR_MISMATCH')
                                    os.fchmod(out, 0o444)
                                    os.fsync(out)
                                finally:
                                    os.close(out)
                            finally:
                                os.close(fd)
                    if seen != set(entries):
                        raise RuntimeError('DSH_IMAGE_TAR_MISSING')
                    for path, e in entries.items():
                        if e['kind'] == 'symlink':
                            check()
                            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), e['target']))
                            fd = parent_fd(root, target)
                            try:
                                s = os.stat(posixpath.basename(target), dir_fd=fd, follow_symlinks=False)
                                if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                                    raise RuntimeError('DSH_IMAGE_SYMLINK_FORBIDDEN')
                            finally:
                                os.close(fd)
                            fd = parent_fd(root, path)
                            try:
                                os.symlink(e['target'], posixpath.basename(path), dir_fd=fd)
                            finally:
                                os.close(fd)
                    for path, e in sorted(entries.items(), key=lambda item: -item[0].count('/')):
                        if e['kind'] == 'directory':
                            fd = parent_fd(root, path)
                            child = os.open(posixpath.basename(path), DIR, dir_fd=fd)
                            try:
                                os.fchmod(child, 0o555)
                                os.fsync(child)
                            finally:
                                os.close(child)
                                os.close(fd)
                    os.fchmod(root, 0o555)
                    os.fsync(root)
                    if verify_tree(root, entries) != tree_sha256:
                        raise RuntimeError('DSH_IMAGE_TREE_DIGEST')
                finally:
                    os.close(root)
                write_new(root_stage, 'manifest.json', raw, 0o444)
                write_new(root_stage, 'descriptor.json', sealed, 0o444)
                os.fchmod(root_stage, 0o555)
                os.fsync(root_stage)
                check()
                if final in os.listdir(parent):
                    raise RuntimeError('DSH_IMAGE_DESTINATION_EXISTS')
                os.rename(stage, final, src_dir_fd=parent, dst_dir_fd=parent)
                renamed = True
                os.fsync(parent)
            finally:
                os.close(root_stage)
        check()
        return dict(kind='allrice-dsh-readonly-directory-receipt-v2', artifactSha256=final,
                    manifestSha256=locks['manifestSha256'], hostDirectory=host,
                    guestDirectory=guest, descriptorPath=os.path.join(request['parent'], final, 'descriptor.json'),
                    sealedManifestSha256=sealed_sha256, treeSha256=tree_sha256)
    finally:
        try:
            if stage is not None and not renamed:
                remove_own(parent, stage, identity)
            os.fsync(parent)
        finally:
            os.close(lock)
            os.close(parent)
            os.close(archive)


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        print(json.dumps(publish(json.load(sys.stdin))))
    except BaseException as error:
        # Neither paths, tar bytes, traceback nor inherited environment reach logs.
        reason = str(error) if isinstance(error, RuntimeError) else ''
        if not re.fullmatch(r'DSH_IMAGE_[A-Z_]{1,64}', reason):
            reason = 'OS_ERROR' if isinstance(error, OSError) else 'UNEXPECTED_ERROR'
        print(json.dumps({'code': 'DSH_IMAGE_PUBLISH_FAILED', 'reason': reason,
                          'errno': error.errno if isinstance(error, OSError) else None}), file=sys.stderr)
        sys.exit(1)
