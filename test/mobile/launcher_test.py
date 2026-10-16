import importlib.util
import io
import json
from pathlib import Path
import subprocess
import time
import types
import unittest
import sys
sys.dont_write_bytecode = True
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).resolve().parents[2] / '.agents/skills/mobile-piop/scripts/setup-debug.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class LauncherTests(unittest.TestCase):
    def test_connection_timeout_retries(self):
        args = types.SimpleNamespace(project=Path('/project'))
        log = types.SimpleNamespace(name='setup.log')
        replies = [subprocess.TimeoutExpired('node', 60), types.SimpleNamespace(returncode=0), types.SimpleNamespace(returncode=0, stdout='{"url":"ws://localhost"}')]
        with patch.object(launcher.subprocess, 'run', side_effect=replies), patch.object(Path, 'is_file', return_value=True):
            self.assertEqual(launcher.connection(args, {}, log, time.monotonic()+180)['url'], 'ws://localhost')

    def test_dependency_death_relaunches_once(self):
        class Client:
            def check(self): pass
            def request(self, *args, **kwargs):
                return {'content':[{'type':'text','text':json.dumps({'exit_code':0,'stdout':'[{"text":"Home"}]'})}]}
        log = io.BytesIO(); log.name = 'setup.log'
        endpoint = {'exec':{'argv':['am','start','-S','-n','dev.pi.mobile/.MainActivity']}}
        dead = {'state':'not_running','lastExit':{'reason':'12 (DEPENDENCY DIED)'}}
        state = lambda *args: {'content':[{'type':'text','text':json.dumps(dead)}]}
        with patch.object(launcher, 'app_stater', return_value=state), patch.object(launcher, 'call') as call, patch.object(launcher.time, 'sleep', side_effect=RuntimeError('stop after retry')):
            with self.assertRaisesRegex(RuntimeError,'stop after retry'):
                launcher.wait_for_workspace(Client(), [], [], time.monotonic()+60, log, endpoint, 'dev.pi.mobile')
            self.assertEqual(call.call_count, 1)

    def test_app_crash_is_reported_not_relaunched(self):
        class Client:
            def check(self): pass
            def request(self, *args, **kwargs):
                return {'content':[{'type':'text','text':json.dumps({'exit_code':0,'stdout':'[{"text":"Home"}]'})}]}
        log = io.BytesIO(); log.name = 'setup.log'
        state = lambda *args: {'content':[{'type':'text','text':json.dumps({'state':'not_running','lastExit':{'reason':'4 (CRASH)'}})}]}
        with patch.object(launcher, 'app_stater', return_value=state), patch.object(launcher, 'call') as call:
            with self.assertRaisesRegex(RuntimeError,'CRASH'):
                launcher.wait_for_workspace(Client(), [], [], time.monotonic()+60, log, {}, 'dev.pi.mobile')
            call.assert_not_called()

class LauncherRecoveryLimitTests(unittest.TestCase):
    def test_repeated_dependency_death_is_reported(self):
        class Client:
            def check(self): pass
            def request(self, *args, **kwargs):
                return {'content':[{'type':'text','text':json.dumps({'exit_code':0,'stdout':'[{"text":"Home"}]'})}]}
        log = io.BytesIO(); log.name = 'setup.log'
        endpoint = {'exec':{'argv':['am','start','-S','-n','dev.pi.mobile/.MainActivity']}}
        state = lambda *args: {'content':[{'type':'text','text':json.dumps({'state':'not_running','lastExit':{'reason':'12 (DEPENDENCY DIED)'}})}]}
        with patch.object(launcher, 'app_stater', return_value=state), patch.object(launcher, 'call') as call, patch.object(launcher.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError,'DEPENDENCY DIED'):
                launcher.wait_for_workspace(Client(), [], [], time.monotonic()+180, log, endpoint, 'dev.pi.mobile')
            self.assertEqual(call.call_count, 1)

if __name__ == '__main__': unittest.main()
