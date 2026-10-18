import ctypes
import select
import json
import os
from pathlib import Path
import signal
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'scripts/test-run.py'

# The child deliberately detaches and ignores TERM, like an unresponsive daemon.
CHILD = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(300)"
FIXTURE = '''
import json, os, pathlib, signal, subprocess, sys, tempfile, time
child = subprocess.Popen([sys.executable, '-c', sys.argv[3]], start_new_session=True, stdout=subprocess.PIPE, text=True)
assert child.stdout.readline().strip() == 'ready'
folder = tempfile.mkdtemp(prefix='piop-runner-check-')
pathlib.Path(folder, 'data').write_text('test')
print(json.dumps({'child': child.pid, 'folder': folder, 'runner': os.getpid(), 'supervisor': os.getppid(), 'unit': os.environ.get('PIOP_TEST_UNIT')}), flush=True)
sys.stdin.readline()
if sys.argv[2] == 'exit': sys.exit(0)
if sys.argv[2] == 'fail': sys.exit(7)
if sys.argv[2] == 'kill': os.kill(os.getpid(), signal.SIGKILL)
time.sleep(300)
'''

class Cleanup(unittest.TestCase):
    def run_case(self, mode, expected=None):
        command = [sys.executable, str(RUNNER), sys.executable, '-c', FIXTURE, '-', mode, CHILD]
        package = tempfile.TemporaryDirectory(prefix='piop-runner-package-')
        if mode == 'bun-killed':
            Path(package.name, 'package.json').write_text(json.dumps({'scripts': {'check': shlex.join(command)}}))
            command = ['bun', 'run', '--cwd', package.name, 'check']
        if mode == 'parent-killed':
            command = [sys.executable, '-c', 'import subprocess,sys; sys.exit(subprocess.call(sys.argv[1:]))', *command]
        process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        info = None
        watch = child_fd = -1
        try:
            self.assertTrue(select.select([process.stdout], [], [], 20)[0], 'Fixture did not start')
            line = process.stdout.readline()
            if not line: self.fail(process.stderr.read())
            info = json.loads(line)
            notify = ctypes.CDLL(None, use_errno=True)
            watch = notify.inotify_init1(os.O_CLOEXEC)
            self.assertGreaterEqual(watch, 0)
            self.assertGreaterEqual(notify.inotify_add_watch(watch, os.fsencode(info['folder']), 0x400), 0)
            child_fd = notify.pidfd_open(info['child'], 0)
            self.assertGreaterEqual(child_fd, 0)
            process.stdin.write('continue\n')
            process.stdin.flush()
            if mode in ('owner-killed', 'parent-killed', 'bun-killed'):
                process.kill()
            elif mode == 'supervisor-killed':
                os.kill(info['supervisor'], signal.SIGKILL)
            elif mode == 'cancel':
                process.terminate()
            output, errors = process.communicate(timeout=20)
            if expected is not None:
                self.assertEqual(process.returncode, expected, errors)
            self.assertTrue(select.select([watch], [], [], 15)[0], 'Temporary folder was not removed')
            self.assertTrue(select.select([child_fd], [], [], 0)[0], 'Child is still running')
            self.assertFalse(Path(info['folder']).exists(), errors)
        finally:
            if process.poll() is None: process.kill(); process.wait()
            for fd in (watch, child_fd):
                if fd >= 0: os.close(fd)
            process.stdin.close()
            process.stdout.close()
            process.stderr.close()
            package.cleanup()
            if info:
                subprocess.run(['systemctl', '--user', 'stop', info['unit']], capture_output=True)

    def test_cleanup_refuses_unmanaged_processes(self):
        result = subprocess.run([sys.executable, str(RUNNER), '--stop'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Cleanup must run inside its own test service', result.stderr)

    def test_exported_shell_function(self):
        env = {**os.environ, 'BASH_FUNC_example%%': '() { true; }'}
        result = subprocess.run([sys.executable, str(RUNNER), '/usr/bin/true'], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_percent_working_directory(self):
        with tempfile.TemporaryDirectory(prefix='piop-%-') as directory:
            copied_runner = Path(directory, 'test-run.py')
            copied_runner.write_text(RUNNER.read_text())
            result = subprocess.run([sys.executable, str(copied_runner), '/usr/bin/pwd'], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), directory)

    def test_literal_arguments(self):
        value = '$HOME ${PATH} %n spaces "quotes"'
        result = subprocess.run([sys.executable, str(RUNNER), sys.executable, '-c', 'import sys; print(sys.argv[1])', value], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), value)

    def test_other_process_survives(self):
        other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            self.run_case('exit', 0)
            self.assertIsNone(other.poll())
        finally:
            other.terminate()
            other.wait(timeout=5)

    def test_success(self): self.run_case('exit', 0)
    def test_failure(self): self.run_case('fail', 7)
    def test_runner_killed(self): self.run_case('kill', 137)
    def test_supervisor_killed(self): self.run_case('supervisor-killed', 255)
    def test_cancel(self): self.run_case('cancel', 143)
    def test_bun_command_killed(self): self.run_case('bun-killed')
    def test_parent_killed(self): self.run_case('parent-killed')
    def test_owner_killed(self): self.run_case('owner-killed')

if __name__ == '__main__': unittest.main()
