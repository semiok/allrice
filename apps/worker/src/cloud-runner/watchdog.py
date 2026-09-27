#!/usr/bin/python3
"""Trusted dedicated-VM guard. No tenant input is interpreted as commands.

Install root-owned outside runsc. The tenant cannot reach the Docker socket,
service or heartbeat. This bounds attempts after Worker crash / guest SIGSTOP.
"""
import datetime
import hashlib
import http.client
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse

LABEL = "xyz.bplabs.allrice.backend"
ATTEMPT = "xyz.bplabs.allrice.cloud.attempt"
DEADLINE = "xyz.bplabs.allrice.cloud.deadline"
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


def tick(capacity):
    filters = urllib.parse.quote(json.dumps({"label": [LABEL + "=cloud-gvisor-v1"]}))
    containers = call("GET", "/containers/json?all=1&filters=" + filters)
    running = 0
    for item in sorted(containers, key=lambda c: c["Created"]):
        identifier = item["Id"]
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("container identity")
        c = call("GET", "/containers/" + identifier + "/json")
        if not c or not c["State"]["Running"]:
            continue
        running += 1
        labels = c["Config"]["Labels"]
        try:
            deadline = int(labels.get(DEADLINE, "0"))
            # Docker-created timestamp prevents a future label from bypassing
            # the physical 65-second ceiling, including runtime startup.
            created = int(item["Created"]) * 1000
            valid = (
                re.fullmatch(r"[a-f0-9-]{36}", labels.get(ATTEMPT, ""))
                and c["HostConfig"]["Runtime"] == "runsc"
                and c["HostConfig"]["NetworkMode"] == "none"
                and deadline > int(time.time() * 1000)
                and deadline <= created + 65_000
                and running <= capacity['slots']
            )
        except (TypeError, ValueError):
            valid = False
        if not valid:
            call("POST", "/containers/" + identifier + "/kill?signal=KILL")
            print(json.dumps({"event": "cloud_watchdog_stop", "container": identifier}), flush=True)
    temporary = STATE + ".new"
    with open(temporary, "w", encoding="utf8") as output:
        json.dump({"at": time.time(), "running": running,
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
    print(json.dumps({"ready": ready, "runtimeChecksum": checksum, "watchdog": "met162-v2",
                      "capacity": capacity, "availableBytes": heartbeat['availableBytes'],
                      "running": heartbeat['running']}))
    return 0 if ready else 1


if __name__ == "__main__":
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
