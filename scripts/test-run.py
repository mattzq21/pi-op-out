import ctypes
import os
import re
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import uuid


def pidfd_open(pid):
    fd = ctypes.CDLL(None, use_errno=True).pidfd_open(pid, 0)
    if fd < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return fd


def service(owner, started, command):
    try:
        owner_fd = pidfd_open(int(owner))
    except ProcessLookupError:
        return 125
    with os.fdopen(owner_fd, 'rb'):
        try:
            current = Path('/proc', owner, 'stat').read_text().rsplit(') ', 1)[1].split()[19]
        except FileNotFoundError:
            return 125
        if current != started or select.select([owner_fd], [], [], 0)[0]:
            return 125
        directory = Path(os.environ['CACHE_DIRECTORY'])
        cache = directory.parent / 'cache'
        env = {**os.environ, 'TMPDIR': str(directory),
               'BUN_INSTALL_CACHE_DIR': str(cache / 'packages'),
               'BUN_RUNTIME_TRANSPILER_CACHE_PATH': str(cache / 'transpiled'),
               'PIOP_TEST_TRANSFORM_CACHE_DIR': str(cache / 'node-transformed'),
               'NODE_COMPILE_CACHE': str(cache / 'node-compiled')}
        for key in ('BUN_INSTALL_CACHE_DIR', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'):
            Path(env[key]).mkdir(parents=True, exist_ok=True)
        child = subprocess.Popen(command, env=env)
        with os.fdopen(pidfd_open(child.pid), 'rb') as child_pid:
            ready, _, _ = select.select([owner_fd, child_pid], [], [])
            if child_pid not in ready:
                return 125
            code = child.wait()
            return code if code >= 0 else 128 - code


def service_group():
    group = Path('/proc/self/cgroup').read_text().strip().split('::', 1)[1]
    unit = os.environ.get('PIOP_TEST_UNIT', '')
    if not re.fullmatch(r'piop-tests-[0-9a-f]{32}\.service', unit) or not group.endswith('/' + unit):
        raise RuntimeError('Cleanup must run inside its own test service')
    return group


def clean():
    service_group()
    directory = Path(os.environ['CACHE_DIRECTORY'])
    if 'piop-tests-' + directory.name + '.service' != os.environ['PIOP_TEST_UNIT']:
        raise RuntimeError('Unexpected test directory')
    shutil.rmtree(directory)
    return 0


def stop():
    group = service_group()
    members = Path('/sys/fs/cgroup' + group) / 'cgroup.procs'
    while True:
        handles = []
        try:
            for pid in map(int, members.read_text().split()):
                if pid == os.getpid():
                    continue
                try:
                    fd = pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    current_group = Path('/proc', str(pid), 'cgroup').read_text().strip().split('::', 1)[1]
                except FileNotFoundError:
                    os.close(fd)
                    continue
                if current_group != group:
                    os.close(fd)
                    continue
                handles.append(fd)
                result = ctypes.CDLL(None, use_errno=True).pidfd_send_signal(fd, signal.SIGKILL, None, 0)
                if result < 0 and ctypes.get_errno() != 3:
                    error = ctypes.get_errno()
                    raise OSError(error, os.strerror(error))
            if not handles:
                return 0
            pending = handles[:]
            while pending:
                ready, _, _ = select.select(pending, [], [])
                pending = [fd for fd in pending if fd not in ready]
        finally:
            for fd in handles:
                os.close(fd)


def run(command):
    if not command:
        raise SystemExit('Usage: python3 scripts/test-run.py COMMAND [ARG ...]')
    executable = shutil.which(command[0])
    if executable is None:
        raise SystemExit('Test command not found: ' + command[0])
    parent = os.getppid()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    if os.getppid() != parent:
        return 125
    identifier = uuid.uuid4().hex
    unit = 'piop-tests-' + identifier
    args = ['systemd-run', '--user', '--wait', '--pipe', '--collect', '--quiet',
            '--expand-environment=no', '--unit=' + unit, '--property=Type=exec', '--property=KillMode=control-group',
            '--property=TimeoutStopSec=5s', '--property=SendSIGKILL=yes',
            '--property=CacheDirectory=piop/tests/' + identifier, '--property=CacheDirectoryMode=0700',
            '--property=WorkingDirectory=' + os.getcwd()]
    quote = lambda value: '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    args.append('--property=ExecStop=:' + quote(sys.executable) + ' ' + quote(str(Path(__file__).resolve())) + ' --stop')
    args.append('--property=ExecStopPost=:' + quote(sys.executable) + ' ' + quote(str(Path(__file__).resolve())) + ' --clean')
    args.extend('--setenv=' + key for key in os.environ
                if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) and key not in ('CACHE_DIRECTORY', 'RUNTIME_DIRECTORY', 'PIOP_TEST_UNIT'))
    args += ['--setenv=PIOP_TEST_UNIT=' + unit + '.service',
             sys.executable, str(Path(__file__).resolve()), '--service', str(os.getpid()),
             Path('/proc/self/stat').read_text().rsplit(') ', 1)[1].split()[19],
             executable, *command[1:]]

    def cancel(signum, _frame):
        # Wait for every child and its temporary directory to be removed before returning.
        result = subprocess.run(['systemctl', '--user', 'stop', unit + '.service'])
        raise SystemExit(128 + signum if result.returncode == 0 else 1)

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    return subprocess.call(args)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--clean']:
        sys.exit(clean())
    if sys.argv[1:2] == ['--stop']:
        sys.exit(stop())
    if sys.argv[1:2] == ['--service']:
        sys.exit(service(sys.argv[2], sys.argv[3], sys.argv[4:]))
    sys.exit(run(sys.argv[1:]))
