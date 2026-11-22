"""Host-only, one-shot readonly code publisher. No guest execution or subprocesses.
The JS release gate supplies trusted locks on stdin; CLI/env cannot change them.
Cancellation is cooperative; the caller must await this process's actual close.
"""
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import posixpath
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


def stamp(s):
    return [str(s.st_dev), str(s.st_ino), str(s.st_ctime_ns)]


def protected(s, directory=False):
    if s.st_uid not in (0, os.getuid()) or s.st_mode & 0o022:
        if not (directory and s.st_uid == 0 and s.st_mode & stat.S_ISVTX):
            raise RuntimeError('DSH_IMAGE_HOST_PERMISSIONS')


def secure_dir(path, create=False):
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        raise RuntimeError('DSH_IMAGE_HOST_PATH')
    fd = os.open('/', DIR)
    try:
        for part in path.split('/')[1:]:
            if not part:
                continue
            protected(os.fstat(fd), True)
            if create:
                check()
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = nxt
        protected(os.fstat(fd), True)
        return fd
    except BaseException:
        os.close(fd)
        raise


def no_acl(fd):
    # Public Darwin ACL API, no ls/chmod child that could outlive cancellation.
    # acl_get_entry returns 0 for an entry and -1/EINVAL for an exhausted ACL.
    if sys.platform == 'darwin':
        lib = ctypes.CDLL(None, use_errno=True)
        lib.acl_get_fd.argtypes = [ctypes.c_int]
        lib.acl_get_fd.restype = ctypes.c_void_p
        lib.acl_valid.argtypes = [ctypes.c_void_p]
        lib.acl_get_entry.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
        lib.acl_free.argtypes = [ctypes.c_void_p]
        acl = lib.acl_get_fd(fd)
        if not acl:
            raise RuntimeError('DSH_IMAGE_ACL_UNKNOWN')
        try:
            if lib.acl_valid(acl) != 0:
                raise RuntimeError('DSH_IMAGE_ACL_UNKNOWN')
            entry = ctypes.c_void_p()
            ctypes.set_errno(0)
            result = lib.acl_get_entry(acl, 0, ctypes.byref(entry))
            if result != -1 or ctypes.get_errno() != errno.EINVAL:
                raise RuntimeError('DSH_IMAGE_ACL_FORBIDDEN')
        finally:
            lib.acl_free(acl)
    elif any(n in os.listxattr(fd) for n in ('system.posix_acl_access', 'system.posix_acl_default')):
        raise RuntimeError('DSH_IMAGE_ACL_FORBIDDEN')


def locked_file(path, size, digest):
    parent = secure_dir(os.path.dirname(path))
    try:
        fd = os.open(os.path.basename(path), RD, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != size:
            raise RuntimeError('DSH_IMAGE_INPUT_SIZE_MISMATCH')
        protected(before)
        h = hashlib.sha256()
        while True:
            check()
            data = os.read(fd, 65536)
            if not data:
                break
            h.update(data)
        after = os.fstat(fd)
        if stamp(before) != stamp(after) or before.st_size != after.st_size or h.hexdigest() != digest:
            raise RuntimeError('DSH_IMAGE_INPUT_DIGEST_MISMATCH')
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
        return [str(os.fstat(child).st_dev), str(os.fstat(child).st_ino)]
    finally:
        os.close(child)


def verify_tree(root, entries, expected_seals=None):
    rs = os.fstat(root)
    if rs.st_uid != os.getuid() or stat.S_IMODE(rs.st_mode) != 0o555:
        raise RuntimeError('DSH_IMAGE_TREE_ROOT')
    found, seals = set(), {'.': stamp(rs)}
    def walk(fd, prefix=''):
        for name in os.listdir(fd):
            check()
            path = prefix + name
            e = entries.get(path)
            if e is None:
                raise RuntimeError('DSH_IMAGE_TREE_EXTRA')
            found.add(path)
            before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if before.st_uid != os.getuid():
                raise RuntimeError('DSH_IMAGE_TREE_OWNER')
            seals[path] = stamp(before)
            if e['kind'] == 'symlink':
                if not stat.S_ISLNK(before.st_mode) or os.readlink(name, dir_fd=fd) != e['target']:
                    raise RuntimeError('DSH_IMAGE_TREE_LINK')
                continue
            mode = e['mode'] & ~0o222
            if stat.S_IMODE(before.st_mode) != mode:
                raise RuntimeError('DSH_IMAGE_TREE_MODE')
            child = os.open(name, DIR if e['kind'] == 'directory' else RD, dir_fd=fd)
            try:
                current = os.fstat(child)
                if stamp(current) != stamp(before):
                    raise RuntimeError('DSH_IMAGE_TREE_CHANGED')
                if e['kind'] == 'directory':
                    walk(child, path + '/')
                else:
                    if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or current.st_size != e['bytes']:
                        raise RuntimeError('DSH_IMAGE_TREE_FILE')
                    h = hashlib.sha256()
                    while True:
                        check()
                        b = os.read(child, 65536)
                        if not b:
                            break
                        h.update(b)
                    if h.hexdigest() != e['sha256']:
                        raise RuntimeError('DSH_IMAGE_TREE_DIGEST')
                if stamp(os.fstat(child)) != stamp(before):
                    raise RuntimeError('DSH_IMAGE_TREE_CHANGED')
            finally:
                os.close(child)
        if stamp(os.fstat(fd)) != seals[prefix[:-1] if prefix else '.']:
            raise RuntimeError('DSH_IMAGE_TREE_CHANGED')
    walk(root)
    if found != set(entries) or (expected_seals is not None and seals != expected_seals):
        raise RuntimeError('DSH_IMAGE_TREE_SEAL')
    return seals


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
    mf = locked_file(request['manifest'], locks['manifestBytes'], locks['manifestSha256'])
    with os.fdopen(mf, 'rb') as source:
        raw = source.read()
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
    archive_stamp = stamp(os.fstat(archive))
    parent = secure_dir(request['parent'], True)
    lock = os.open('.publish.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    stage, identity, facts, facts_identity, renamed = None, None, None, None, False
    try:
        no_acl(parent)
        ls = os.fstat(lock)
        if not stat.S_ISREG(ls.st_mode) or ls.st_uid != os.getuid() or ls.st_nlink != 1 or stat.S_IMODE(ls.st_mode) != 0o600:
            raise RuntimeError('DSH_IMAGE_LOCK_UNKNOWN')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check()
        final = locks['archiveSha256']
        host = os.path.join(request['parent'], final, 'public')
        guest = '/opt/allrice/dsh/' + final
        try:
            existing = os.open(final, DIR, dir_fd=parent)
        except FileNotFoundError:
            existing = None
        if existing is not None:
            try:
                fd = os.open('descriptor.json', RD, dir_fd=existing)
                with os.fdopen(fd, 'rb') as src:
                    descriptor = json.load(src)
                saved = os.open('manifest.json', RD, dir_fd=existing)
                with os.fdopen(saved, 'rb') as src:
                    if hashlib.sha256(src.read()).hexdigest() != locks['manifestSha256']:
                        raise RuntimeError('DSH_IMAGE_TREE_SEAL')
                if (descriptor['hostDirectory'] != host or descriptor['guestDirectory'] != guest
                        or descriptor['manifestSha256'] != locks['manifestSha256']
                        or descriptor['artifactSha256'] != final or descriptor['baseImage'] != BASE
                        or descriptor['kind'] != 'allrice-dsh-readonly-directory-v1'
                        or descriptor['manifestBytes'] != locks['manifestBytes']
                        or descriptor['archiveBytes'] != locks['archiveBytes']
                        or descriptor['dshVersion'] != '0.2.1-rc.2' or descriptor['nodeVersion'] != '22.23.2'):
                    raise RuntimeError('DSH_IMAGE_TREE_SEAL')
                root = os.open('public', DIR, dir_fd=existing)
                try:
                    verify_tree(root, entries, descriptor['seals'])
                finally:
                    os.close(root)
            finally:
                os.close(existing)
        else:
            stage = '.' + final + '.stage-' + str(uuid.uuid4())
            os.mkdir(stage, 0o700, dir_fd=parent)
            root_stage = os.open(stage, DIR, dir_fd=parent)
            identity = [str(os.fstat(root_stage).st_dev), str(os.fstat(root_stage).st_ino)]
            facts = stage + '.json'
            try:
                facts_identity = write_new(parent, facts, json.dumps({'stage': stage, 'identity': identity, 'pid': os.getpid()}).encode())
                os.fsync(parent)
                no_acl(root_stage)
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
                                    h, size = hashlib.sha256(), 0
                                    with tar.extractfile(item) as src, os.fdopen(out, 'wb', closefd=False) as dst:
                                        while True:
                                            check()
                                            data = src.read(65536)
                                            if not data:
                                                break
                                            h.update(data)
                                            size += len(data)
                                            dst.write(data)
                                        dst.flush()
                                    if size != e['bytes'] or h.hexdigest() != e['sha256']:
                                        raise RuntimeError('DSH_IMAGE_TAR_DIGEST')
                                    os.fchmod(out, e['mode'] & ~0o222)
                                    os.fsync(out)
                                finally:
                                    os.close(out)
                            finally:
                                os.close(fd)
                    if stamp(os.fstat(archive)) != archive_stamp:
                        raise RuntimeError('DSH_IMAGE_INPUT_DIGEST_MISMATCH')
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
                                os.fchmod(child, e['mode'] & ~0o222)
                                os.fsync(child)
                            finally:
                                os.close(child)
                                os.close(fd)
                    os.fchmod(root, 0o555)
                    os.fsync(root)
                    seals = verify_tree(root, entries)
                finally:
                    os.close(root)
                with open(__file__, 'rb') as publisher_source:
                    publisher_sha256 = hashlib.sha256(publisher_source.read()).hexdigest()
                descriptor = dict(kind='allrice-dsh-readonly-directory-v1', artifactSha256=final,
                                  archiveBytes=locks['archiveBytes'], manifestSha256=locks['manifestSha256'],
                                  manifestBytes=locks['manifestBytes'], baseImage=BASE, hostDirectory=host,
                                  guestDirectory=guest, dshVersion='0.2.1-rc.2', nodeVersion='22.23.2',
                                  publisherSha256=publisher_sha256,
                                  gateSha256=request['gateSha256'], seals=seals)
                write_new(root_stage, 'manifest.json', raw)
                write_new(root_stage, 'descriptor.json', json.dumps(descriptor, separators=(',', ':')).encode())
                os.fchmod(root_stage, 0o555)
                os.fsync(root_stage)
                check()
                # All trusted writers hold this same inode lock. Never replace an existing destination.
                if final in os.listdir(parent):
                    raise RuntimeError('DSH_IMAGE_DESTINATION_EXISTS')
                os.rename(stage, final, src_dir_fd=parent, dst_dir_fd=parent)
                renamed = True
                os.fsync(parent)
            finally:
                os.close(root_stage)
        check()
        return dict(kind='allrice-dsh-readonly-directory-receipt-v1', artifactSha256=final,
                    manifestSha256=locks['manifestSha256'], hostDirectory=host,
                    guestDirectory=guest, descriptorPath=os.path.join(request['parent'], final, 'descriptor.json'))
    finally:
        try:
            if stage is not None and not renamed:
                remove_own(parent, stage, identity)
            if facts is not None:
                fs = os.stat(facts, dir_fd=parent, follow_symlinks=False)
                if facts_identity != [str(fs.st_dev), str(fs.st_ino)] or fs.st_uid != os.getuid() or not stat.S_ISREG(fs.st_mode):
                    raise RuntimeError('DSH_IMAGE_STAGE_UNKNOWN')
                os.unlink(facts, dir_fd=parent)
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
    except BaseException:
        # Neither paths, tar bytes, traceback nor inherited environment reach logs.
        print(json.dumps({'code': 'DSH_IMAGE_PUBLISH_FAILED'}), file=sys.stderr)
        sys.exit(1)
