#!/usr/bin/python3
"""Trusted dedicated-VM guard. No tenant input is interpreted as commands.

Install root-owned outside runsc. The tenant cannot reach the Docker socket,
service or heartbeat. This bounds attempts after Worker crash / guest SIGSTOP.
"""
import datetime
import hashlib
import http.client
import json
import math
import os
import re
import select
import stat
import socket
import subprocess
import sys
import time
import urllib.parse

LABEL = "xyz.bplabs.allrice.backend"
ATTEMPT = "xyz.bplabs.allrice.cloud.attempt"
DEADLINE = "xyz.bplabs.allrice.cloud.deadline"
SERVICE_LEASES = "/run/allrice-cloud-project-leases"
SERVICE = "xyz.bplabs.allrice.cloud.service"
SERVICE_ID = "xyz.bplabs.allrice.cloud.service-id"
COMPILED_PROFILE = 'allrice.output-redaction.compiled.v1'
COMPILED_TIMEOUT_STEP = 300_000
COMPILED_TIMEOUT_MAX = 1_800_000
NODE_IMAGE = 'sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5'
STATE = "/run/allrice-cloud-watchdog.json"
CAPACITY = "/run/allrice-cloud-capacity.json"
EXPECTED = "1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a"
SIDECARS = {
    "checkpointgofer": "205cc047fcbbec7de29fb41f2ef403a22aa0063332e3f4f13a566f4d56a95d84",
    "gvisor-sentry-prewarmer": "3315d7ad7c2d3751d349e4976fa02da1da6fd7e41746c35622304e5fabe4fce0",
    "gvisor_sentry": "66f1e15d15424a87fc883df4597c5d0cfcd442ce3f82e208a69110f0949613c1",
    "runsc-metric-server": "7e01c8637f2412aefe4a26eefc8e40f4e8184dc95be44b2b646f38ab3d260033",
}


class Docker(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=3)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(3)
        self.sock.connect("/var/run/docker.sock")


def call(method, path):
    connection = Docker()
    try:
        connection.request(method, "/v1.45" + path)
        response = connection.getresponse()
        data = response.read(1_000_001)
        if len(data) > 1_000_000 or response.status not in (200, 204, 304, 404, 409):
            raise RuntimeError("docker unavailable")
        return json.loads(data) if data and response.status == 200 else None
    finally:
        connection.close()


def memory_available():
    with open('/proc/meminfo', encoding='utf8') as source:
        values = dict((line.split(':')[0], int(line.split()[1]) * 1024) for line in source)
    return values['MemAvailable']


def calculate_capacity(memory_bytes, cpus, services_bytes=0):
    # Budget 512 MiB per script + 128 MiB for the runsc/runtime overhead.
    # A minimum of two would overcommit small machines. CPU may be shared by
    # two scripts/core; the memory bound is always enforced independently.
    reserve = max(512 * 1024 ** 2, int(memory_bytes * 0.2))
    slots = max(0, min(32, int(cpus * 2), (memory_bytes - reserve - services_bytes) // (640 * 1024 ** 2)))
    return {'version': 2, 'memoryBytes': memory_bytes, 'cpus': cpus,
            'reservedBytes': reserve, 'servicesBytes': services_bytes, 'slots': slots}


def detect_capacity():
    info = call('GET', '/info')
    memory = int(info['MemTotal'])
    cpus = float(info['NCPU'])
    # Read the sandbox parent, not this watchdog service's 64 MiB cgroup.
    parent = info.get('CgroupParent') or ''
    if '..' in parent.split('/'):
        raise RuntimeError('invalid cgroup parent')
    directory = os.path.join('/sys/fs/cgroup', parent.lstrip('/'))
    while directory.startswith('/sys/fs/cgroup'):
        try:
            with open(directory + '/memory.max') as source:
                value = source.read().strip()
                if value != 'max': memory = min(memory, int(value))
        except FileNotFoundError:
            pass
        try:
            with open(directory + '/cpu.max') as source:
                quota, period = source.read().split()
                if quota != 'max': cpus = min(cpus, int(quota)/int(period))
        except FileNotFoundError:
            pass
        if directory == '/sys/fs/cgroup': break
        directory = os.path.dirname(directory)
    # The VM may also host the Office preview renderer. Reserve other running
    # containers' declared memory, or current RSS when they have no limit.
    # This is a startup inventory, not a continuously changing controller.
    services = 0
    for container in call('GET', '/containers/json'):
        if container.get('Labels', {}).get(LABEL) == 'cloud-gvisor-v1': continue
        detail = call('GET', '/containers/' + container['Id'] + '/json')
        limit = detail['HostConfig'].get('Memory', 0)
        if not limit:
            stats = call('GET', '/containers/' + container['Id'] + '/stats?stream=false&one-shot=true')
            limit = stats.get('memory_stats', {}).get('usage', 0)
        services += limit
    result = {**calculate_capacity(memory, cpus, services), 'backendId': info['ID']}
    with open(CAPACITY + '.new', 'w', encoding='utf8') as output:
        json.dump(result, output)
    os.replace(CAPACITY + '.new', CAPACITY)
    print(json.dumps({'event': 'cloud_capacity', **result}), flush=True)
    return result


def service_lease_valid(labels, created, deadline, now):
    if labels.get(SERVICE) != 'project-v1' or labels.get('xyz.bplabs.allrice.cloud.kind') != 'project':
        return False
    attempt = labels.get(ATTEMPT, '')
    if not re.fullmatch(r'[a-f0-9-]{36}', attempt) or not re.fullmatch(r'[a-f0-9-]{36}', labels.get(SERVICE_ID, '')):
        return False
    if deadline > created + 3_601_000:
        return False
    try:
        filename = SERVICE_LEASES + '/' + attempt + '.json'
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, encoding='utf8') as source:
            metadata = os.fstat(source.fileno())
            if metadata.st_uid != 0 or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 or metadata.st_mode & 0o077:
                return False
            lease = json.load(source)
        return lease['attempt'] == attempt and lease['hardDeadline'] == deadline and now < lease['expiresAt'] <= min(deadline, now + 5500)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def service_lease_channel(attempt, hard_text):
    # Fixed root-owned infrastructure ingress, never reachable by project code.
    hard = int(hard_text)
    if os.getuid() != 0 or not re.fullmatch(r'[a-f0-9-]{36}', attempt) or not int(time.time()*1000) < hard <= int(time.time()*1000)+3_600_000:
        return 1
    os.makedirs(SERVICE_LEASES, mode=0o700, exist_ok=True)
    metadata = os.lstat(SERVICE_LEASES)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
        return 1
    filename = SERVICE_LEASES + '/' + attempt + '.json'
    # A second owner cannot replace an established physical lease channel.
    fd = os.open(filename + ".owner", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    inode = os.fstat(fd).st_ino
    def save(expiry):
        data = json.dumps({'attempt':attempt,'hardDeadline':hard,'expiresAt':expiry}).encode()
        temporary = filename + '.new'
        writer = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(writer, data); os.fsync(writer)
        finally:
            os.close(writer)
        os.replace(temporary, filename)
    sequence = 0
    try:
        save(min(hard, int(time.time()*1000)+5000))
        print(json.dumps({'sequence':-1,'ready':True}), flush=True)
        while time.time()*1000 < hard:
            if not select.select([sys.stdin], [], [], 5)[0]:
                return 1
            line = sys.stdin.buffer.readline(1025)
            if not line or len(line)>1024 or not line.endswith(b'\n'):
                return 1
            frame = json.loads(line)
            now = int(time.time()*1000)
            expiry = frame['expiresAt']
            if frame['sequence'] != sequence or not isinstance(expiry,int) or not now < expiry <= min(hard,now+5500):
                return 1
            save(expiry)
            print(json.dumps({'sequence':sequence,'ready':True}),flush=True)
            sequence += 1
    finally:
        os.close(fd)
        try:
            if os.lstat(filename + '.owner').st_ino == inode:
                try: os.unlink(filename)
                except FileNotFoundError: pass
                os.unlink(filename + '.owner')
        except FileNotFoundError:
            pass
    return 0


def project_web_container_valid(container):
    config, host = container['Config'], container['HostConfig']
    labels = config['Labels']
    cache = labels.get('xyz.bplabs.allrice.project.cache', '')
    attempt = labels.get(ATTEMPT, '')
    mounts = container.get('Mounts', [])
    return (
        labels.get('xyz.bplabs.allrice.project.profile') == 'web-development'
        and labels.get('xyz.bplabs.allrice.cloud.kind') == 'project'
        and re.fullmatch(r'sha256:[a-f0-9]{64}', cache)
        and re.fullmatch(r'[a-f0-9]{64}', labels.get('xyz.bplabs.allrice.project.payload', ''))
        and re.fullmatch(r'[a-f0-9-]{36}', attempt)
        and config.get('Image') == NODE_IMAGE and config.get('User') == '0:0'
        and host.get('Runtime') == 'runsc' and host.get('NetworkMode') == 'none'
        and host.get('ReadonlyRootfs') is True and not host.get('Privileged')
        and host.get('CapDrop') == ['ALL']
        and sorted(cap.removeprefix('CAP_') for cap in host.get('CapAdd', [])) == ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID']
        and 'no-new-privileges' in host.get('SecurityOpt', [])
        and not host.get('Binds') and len(mounts) == 2
        and {m.get('Destination'): m.get('Name') for m in mounts if m.get('Type') == 'volume'} == {
            '/tmp/work': 'allrice-project-work-' + attempt,
            '/cache': 'allrice-project-cache-' + cache[7:]}
        and 128 * 1024 ** 2 <= host.get('Memory', 0) <= 1536 * 1024 ** 2
        and host.get('MemorySwap') == host.get('Memory') and 64 <= host.get('PidsLimit', 0) <= 128
        and host.get('Tmpfs') == {'/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777'}
    )


def command_deadline_valid(container, created, deadline):
    """Only the fixed private compiler profile has the operator-frozen budget.

    These root-owned Docker facts bound execution after Worker loss. Admission
    and the source/command proofs remain the Worker's responsibility; a label
    alone neither authorizes candidate code nor grants a longer ordinary task.
    """
    config, host = container['Config'], container['HostConfig']
    labels = config['Labels']
    if labels.get('xyz.bplabs.allrice.project.profile') is not None:
        return deadline <= created + 601_000 and project_web_container_valid(container)
    profile = labels.get('xyz.bplabs.allrice.repository.profile')
    if profile is None:
        return deadline <= created + 65_000
    value = labels.get('xyz.bplabs.allrice.repository.timeout', '')
    if profile != COMPILED_PROFILE or not re.fullmatch(r'[1-9][0-9]*', value):
        return False
    timeout = int(value)
    return (
        COMPILED_TIMEOUT_STEP <= timeout <= COMPILED_TIMEOUT_MAX
        and timeout % COMPILED_TIMEOUT_STEP == 0
        # Docker's inventory creation timestamp is rounded to whole seconds.
        and deadline <= created + timeout + 1000
        and labels.get('xyz.bplabs.allrice.cloud.kind') == 'repository'
        and labels.get('xyz.bplabs.allrice.repository.input-limit') == '23000000'
        and re.fullmatch(r'sha256:[a-f0-9]{64}', labels.get('xyz.bplabs.allrice.repository.command', ''))
        and re.fullmatch(r'sha256:[a-f0-9]{64}', labels.get('xyz.bplabs.allrice.repository.dependency', ''))
        and config.get('Image') == NODE_IMAGE and config.get('User') == '0:0'
        and host.get('ReadonlyRootfs') is True and not host.get('Privileged')
        and host.get('CapDrop') == ['ALL']
        and sorted(cap.removeprefix('CAP_') for cap in host.get('CapAdd', [])) == ['KILL', 'SETGID', 'SETUID']
        and 'no-new-privileges' in host.get('SecurityOpt', [])
        and not host.get('Binds') and not container.get('Mounts')
        and host.get('Memory') == 768 * 1024 ** 2
        and host.get('MemorySwap') == 768 * 1024 ** 2
        and host.get('PidsLimit') == 64
        and host.get('Tmpfs') == {'/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777'}
    )


def compiled_budget():
    return {'profileId': COMPILED_PROFILE, 'timeoutStepMs': COMPILED_TIMEOUT_STEP, 'maximumTimeoutMs': COMPILED_TIMEOUT_MAX, 'memoryMiB': 768}


def project_web_budget():
    return {'profileId': 'web-development', 'maximumTimeoutMs': 600000, 'maximumMemoryMiB': 1536, 'maximumPids': 128}


def live_project_web_budget(heartbeat):
    return project_web_budget() if heartbeat.get('projectWebDevelopment') == project_web_budget() else None


def live_compiled_budget(heartbeat):
    # This must come from the actual running tick, not merely the script now
    # on disk: an old service may still be applying its 65-second ceiling.
    return compiled_budget() if heartbeat.get('repositoryCompiled') == compiled_budget() else None


def tick(capacity):
    filters = urllib.parse.quote(json.dumps({"label": [LABEL + "=cloud-gvisor-v1"]}))
    containers = call("GET", "/containers/json?all=1&filters=" + filters)
    running = 0
    reserved_units = 0
    for item in sorted(containers, key=lambda c: c["Created"]):
        identifier = item["Id"]
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("container identity")
        c = call("GET", "/containers/" + identifier + "/json")
        if not c or not c["State"]["Running"]:
            continue
        running += 1
        reserved_units += math.ceil((c['HostConfig'].get('Memory', 0) + 128 * 1024 ** 2) / (640 * 1024 ** 2))
        labels = c["Config"]["Labels"]
        try:
            deadline = int(labels.get(DEADLINE, "0"))
            # Docker creation binds the ordinary or frozen private ceiling,
            # including runtime startup; it cannot be renewed by a label.
            created = int(item["Created"]) * 1000
            valid = (
                re.fullmatch(r"[a-f0-9-]{36}", labels.get(ATTEMPT, ""))
                and c["HostConfig"]["Runtime"] == "runsc"
                and c["HostConfig"]["NetworkMode"] == "none"
                and deadline > int(time.time() * 1000)
                and (labels.get('xyz.bplabs.allrice.project.profile') is None or project_web_container_valid(c))
                and (service_lease_valid(labels, created, deadline, int(time.time()*1000))
                     if SERVICE in labels else command_deadline_valid(c, created, deadline))
                and reserved_units <= capacity['slots']
            )
        except (TypeError, ValueError):
            valid = False
        if not valid:
            call("POST", "/containers/" + identifier + "/kill?signal=KILL")
            print(json.dumps({"event": "cloud_watchdog_stop", "container": identifier}), flush=True)
    temporary = STATE + ".new"
    with open(temporary, "w", encoding="utf8") as output:
        json.dump({"at": time.time(), "running": running, 'repositoryCompiled': compiled_budget(),
                   'projectWebDevelopment': project_web_budget(),
                   "availableBytes": memory_available()}, output)
    os.replace(temporary, STATE)


def attest():
    with open(CAPACITY, encoding='utf8') as source:
        capacity = json.load(source)
    with open("/usr/local/bin/runsc", "rb") as binary:
        checksum = hashlib.file_digest(binary, "sha256").hexdigest()
    with open("/etc/docker/daemon.json", encoding="utf8") as config:
        runtime = json.load(config)["runtimes"]["runsc"]
    active = subprocess.run(
        ["/usr/bin/systemctl", "is-active", "--quiet", "allrice-cloud-watchdog.service"],
        check=False,
    ).returncode == 0
    sidecars = {}
    for name in SIDECARS:
        with open("/usr/local/bin/gvisor-bin/" + name, "rb") as binary:
            sidecars[name] = hashlib.file_digest(binary, "sha256").hexdigest()
    # Binary hashing can take seconds on a busy two-core VM. Read the current
    # heartbeat afterwards, instead of aging a previously healthy sample while
    # doing unrelated I/O. The same four-second freshness bound still applies.
    with open(STATE, encoding="utf8") as state:
        heartbeat = json.load(state)
    ready = (
        os.getuid() == 0
        and checksum == EXPECTED
        and sidecars == SIDECARS
        and runtime == {"path": "/usr/local/bin/runsc", "runtimeArgs": ["--directfs=false", "--oci-seccomp=false"]}
        and active
        and 0 <= time.time() - heartbeat["at"] < 4
    )
    print(json.dumps({"ready": ready, "runtimeChecksum": checksum, "watchdog": "met166-service-v1", "projectServices": True,
                      "repositoryCompiled": live_compiled_budget(heartbeat),
                      "projectWebDevelopment": live_project_web_budget(heartbeat),
                      "capacity": capacity, "availableBytes": heartbeat['availableBytes'],
                      "running": heartbeat['running']}))
    return 0 if ready else 1


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == '--project-service-lease':
        sys.exit(service_lease_channel(sys.argv[2], sys.argv[3]))
    if sys.argv[1:] == ["--attest"]:
        sys.exit(attest())
    if len(sys.argv) != 1 or os.getuid() != 0:
        sys.exit(1)
    capacity = detect_capacity()
    while True:
        try:
            tick(capacity)
        except Exception as error:
            # No fresh heartbeat on errors: new execution fails closed.
            print(json.dumps({"event": "cloud_watchdog_unavailable", "error": type(error).__name__}), flush=True)
        time.sleep(0.5)
