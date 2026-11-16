"""Per-invocation deployment receipt, written only after deploy-dev's exit cleanup."""
import json
import os
from pathlib import Path
import sys
import time
import uuid


def main():
    mode = sys.argv[1]
    if mode == 'start':
        path = Path(sys.argv[2])
        task_id = sys.argv[3]
        if not path.is_absolute() or not task_id or path.is_symlink():
            raise ValueError('receipt needs an absolute new path and nonempty ID')
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as stream:
            json.dump(dict(id=task_id, status='running', startedAt=time.time()), stream)
    elif mode == 'finish':
        path = Path(sys.argv[2])
        state = json.loads(path.read_text())
        if path.is_symlink() or state['id'] != sys.argv[3] or state['status'] != 'running':
            raise ValueError('receipt identity mismatch')
        state.update(status='completed', exitCode=int(sys.argv[4]), endedAt=time.time())
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(state, stream)
        temporary.replace(path)
    else:
        raise ValueError('unknown receipt action')


if __name__ == '__main__':
    main()
