#!/usr/bin/env python3
"""MCP server: build a Piop worktree, run its connected debug app in a private android-vm-broker VM, and serve its Android CLI tools."""

import argparse
import contextlib
import shlex
from concurrent.futures import Future
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import re
import runpy
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import uuid
import zipfile

NAME = "mobile-piop"
MARKER = "MOBILE_PIOP_INSTANCE"
CACHE = Path.home() / ".cache" / NAME
STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
REINSTALL_TOOL = {
    "name": "reinstall",
    "description": "Rebuild this worktree's debug daemon and app, then install and start the app in this VM. Use after code changes.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}


# Processes and deadlines

class Shutdown(BaseException):
    def __init__(self, signum):
        self.code = 128 + signum


def remaining(deadline, maximum=None):
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("Launcher deadline expired")
    return left if maximum is None else min(left, maximum)


@contextlib.contextmanager
def file_lock(path, deadline):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+b") as handle:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining(deadline)
                time.sleep(0.2)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run_step(command, *, env, cwd, log, children, deadline, label, input_text=None):
    print(label, file=sys.stderr, flush=True)
    log.write(f"\n$ {' '.join(map(str, command))}\n".encode())
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE if input_text else subprocess.DEVNULL,
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append((label, process))
    try:
        if input_text:
            process.stdin.write(input_text.encode())
            process.stdin.close()
        try:
            code = process.wait(timeout=remaining(deadline))
        except subprocess.TimeoutExpired as error:
            raise TimeoutError(f"{label} did not finish before the deadline; see {log.name}") from error
    finally:
        children.remove((label, process))
        if process.poll() is None:
            process.kill()
            process.wait()
    if code:
        raise RuntimeError(f"{label} failed with status {code}; see {log.name}")


def runtime_root():
    root = Path(tempfile.gettempdir()) / f"{NAME}-{os.getuid()}"
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Expected a private directory owned by this user: {root}")
    return root


def has_marker(pid, marker):
    try:
        return marker in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False


def owned_pids(marker):
    return [entry.name for entry in Path("/proc").iterdir() if entry.name.isdigit() and has_marker(entry.name, marker)]


def ensure_running(children):
    for name, child in children:
        code = child.poll()
        if code is not None:
            raise RuntimeError(f"{name} exited with status {code}")


def signal_owned(marker, signum):
    for pid in owned_pids(marker):
        try:
            # Recheck immediately before signaling to avoid acting on a stale PID.
            if has_marker(pid, marker):
                os.kill(int(pid), signum)
        except ProcessLookupError:
            pass


def stop_children(children, marker):
    # Stop supervisors first, then sweep descendants that started new process groups.
    for _, child in reversed(children):
        if child.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                child.terminate()
    time.sleep(0.2)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not owned_pids(marker):
            break
        signal_owned(marker, signal.SIGTERM)
        time.sleep(0.2)
    signal_owned(marker, signal.SIGKILL)
    for _, child in children:
        with contextlib.suppress(subprocess.TimeoutExpired):
            child.wait(timeout=2)


# MCP client

class McpError(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message", str(error)))


class McpClient:
    """JSON-RPC client for an MCP server on a child process's stdio."""

    def __init__(self, process, name="MCP server"):
        self.process = process
        self.name = name
        self.pending = {}
        self.failure = None
        self.state_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.call_lock = threading.Lock()
        self.reader = threading.Thread(target=self.read_responses, daemon=True)
        self.reader.start()

    def send(self, message):
        with self.write_lock:
            self.process.stdin.write((json.dumps(message) + "\n").encode())
            self.process.stdin.flush()

    def read_responses(self):
        failure = f"{self.name} disconnected"
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    raise RuntimeError(f"Invalid JSON-RPC output from {self.name}")
                if "method" in message:
                    if "id" in message:
                        self.send({"jsonrpc": "2.0", "id": message["id"], "error": {
                            "code": -32601, "message": "This client does not provide sampling, roots, or elicitation"}})
                    continue
                with self.state_lock:
                    response_queue = self.pending.pop(message.get("id"), None)
                if response_queue is not None:
                    response_queue.put(message)
        except Exception as error:
            failure = f"{self.name} transport failed: {error}"
        finally:
            with self.state_lock:
                self.failure = failure
                pending = list(self.pending.values())
                self.pending.clear()
            for response_queue in pending:
                response_queue.put({"error": {"code": -32000, "message": failure}})

    def check(self):
        with self.state_lock:
            if self.failure:
                raise RuntimeError(self.failure)

    def notify(self, method, params=None):
        self.send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def request(self, method, params=None, timeout=120):
        deadline = time.monotonic() + timeout
        if not self.call_lock.acquire(timeout=timeout):
            raise TimeoutError(f"Another {self.name} call is still running")
        request_id = str(uuid.uuid4())
        response_queue = queue.Queue()
        try:
            with self.state_lock:
                if self.failure:
                    raise RuntimeError(self.failure)
                self.pending[request_id] = response_queue
            self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
            try:
                message = response_queue.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as error:
                with contextlib.suppress(Exception):
                    self.notify("notifications/cancelled", {"requestId": request_id, "reason": "Launcher request timeout"})
                raise TimeoutError(f"{self.name} call timed out; inspect the app before retrying an interaction") from error
            if "error" in message:
                raise McpError(message["error"])
            return message["result"]
        finally:
            with self.state_lock:
                self.pending.pop(request_id, None)
            self.call_lock.release()

    def close(self):
        with contextlib.suppress(OSError):
            self.process.stdin.close()
        self.reader.join(timeout=1)
        if not self.reader.is_alive():
            self.process.stdout.close()


def initialize(client, name, timeout):
    result = client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                           "clientInfo": {"name": name, "version": "1.0.0"}}, timeout=timeout)
    client.notify("notifications/initialized")
    return result


def require_tool_success(result, operation):
    if not isinstance(result, dict) or result.get("isError"):
        raise RuntimeError(f"{operation} failed: {json.dumps(result)}")


# Android SDK

def sdk_root(env=os.environ):
    for candidate in (env.get("ANDROID_HOME"), env.get("ANDROID_SDK_ROOT"), str(Path.home() / "Android/Sdk")):
        if candidate and Path(candidate).expanduser().is_dir():
            return Path(candidate).expanduser().resolve()
    raise RuntimeError("Android SDK not found; set ANDROID_HOME")


# App state

APP_STATE_TOOL = {
    "name": "app_state",
    "description": "Report whether a package is not_installed, not_running, background, or foreground. Defaults to the launched app.",
    "inputSchema": {"type": "object", "properties": {"package": {"type": "string", "minLength": 1}}, "additionalProperties": False},
}


def observe(client, argv, deadline):
    """Run argv in the VM through the broker's exec tool; return its exit code and stdout.

    The broker marks a non-zero exit as an error, so only output we cannot read is a failure here."""
    result = client.request("tools/call", {"name": "exec", "arguments": {"argv": argv}}, timeout=remaining(deadline, 60))
    try:
        observation = json.loads(result["content"][0]["text"])
        code = observation["exit_code"]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise RuntimeError(f"{argv[0]} failed in the VM: {json.dumps(result)[:1000]}") from error
    if observation.get("timed_out") or observation.get("truncated") or code not in (0, 1):
        raise RuntimeError(f"{argv[0]} failed in the VM: {json.dumps(observation)[:1000]}")
    return code, observation.get("stdout", "")


def app_stater(client, app_id):
    """Return the app_state tool handler."""
    def app_state(_name, arguments):
        deadline = time.monotonic() + 60
        package = arguments.get("package") or app_id
        code, _ = observe(client, ["/system/bin/pm", "path", package], deadline)
        if code:
            state, pids = "not_installed", []
        else:
            _, found = observe(client, ["/system/bin/pidof", package], deadline)
            pids = [int(pid) for pid in found.split()]
            _, activities = observe(client, ["/system/bin/sh", "-c", "dumpsys activity activities | grep ResumedActivity"], deadline)
            resumed = re.findall(r" ([\w.]+)/", activities)
            state = "not_running" if not pids else "foreground" if package in resumed else "background"
        return {"content": [{"type": "text", "text": json.dumps({"package": package, "state": state, "pids": pids})}]}

    return app_state


# Piop build

def connection(args, env, log, deadline):
    for attempt in range(2):
        result = subprocess.run(["node", "scripts/mobile-debug-connection.mjs"], cwd=args.project,
                                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log,
                                text=True, timeout=min(60, deadline - time.monotonic()))
        if result.returncode == 0:
            return json.loads(result.stdout)
        if attempt == 0:
            print("Restarting this worktree's debug daemon to use its rebuilt binary.", file=sys.stderr, flush=True)
            daemon = next((path for path in (args.project / "target/debug/piopd", args.project / "src-tauri/target/debug/piopd") if path.is_file()), None)
            if daemon is None:
                raise RuntimeError("Could not find this worktree's debug daemon to restart it.")
            subprocess.run([str(daemon), "stop"], cwd=args.project,
                           env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                           check=True, timeout=min(60, deadline - time.monotonic()))
    raise RuntimeError(f"Worktree debug daemon connection failed; see {log.name}.")


def java_home(env):
    candidates = [Path(env["JAVA_HOME"])] if env.get("JAVA_HOME") else []
    candidates.extend(sorted((Path.home() / ".gradle/jdks").glob("*")))
    candidates.extend(sorted(Path("/usr/lib/jvm").glob("*")))
    candidates.append(Path.home() / "Applications/android-studio/jbr")
    java = shutil.which("java")
    if java:
        candidates.append(Path(java).resolve().parent.parent)
    for candidate in candidates:
        try:
            version = re.search(r'^JAVA_VERSION="([0-9]+)', (candidate / "release").read_text(), re.MULTILINE)
            if version and version.group(1) == "21" and (candidate / "bin/javac").is_file():
                return str(candidate.resolve())
        except OSError:
            continue
    raise RuntimeError("A Java 21 JDK is required for this Android build; none was found in JAVA_HOME, Gradle's JDK cache, or system JVMs")


def prepare_apk(args, env, directory, log, children, deadline):
    android_project = args.project / "clients/android"
    if not (android_project / "gradlew").is_file():
        android_project = args.project / "android"
    if args.apk:
        source = args.apk
    else:
        # Serialize packaging within a checkout; worktrees have their own lock.
        project_key = hashlib.sha256(str(args.project).encode()).hexdigest()[:24]
        with file_lock(CACHE / f"build-{project_key}.lock", deadline):
            for command, cwd, label in [
                (["node", "node_modules/vite/bin/vite.js", "build", "--mode", "mobile", "--outDir", "dist-mobile"], args.project, "Packaging Piop's static mobile frontend."),
                (["node", "node_modules/@capacitor/cli/bin/capacitor", "sync", "android"], args.project, "Syncing the packaged frontend into Android."),
                (["./gradlew", "--no-daemon", *(["--init-script", str(args.gradle_init)] if getattr(args, "gradle_init", None) else []), "assembleDebug"], android_project, "Building the installable Android debug APK."),
            ]:
                run_step(command, env=env, cwd=cwd, log=log, children=children, deadline=deadline, label=label)
            source = android_project / "app/build/outputs/apk/debug/app-debug.apk"
            shutil.copy2(source, directory / "app.apk")
        source = directory / "app.apk"
    if source != directory / "app.apk":
        shutil.copy2(source, directory / "app.apk")
    with zipfile.ZipFile(directory / "app.apk") as apk:
        config = json.loads(apk.read("assets/capacitor.config.json"))
    if config.get("server", {}).get("url"):
        raise RuntimeError("APK uses server.url; package local assets without live reload first")
    app_id = config.get("appId")
    if not app_id:
        raise RuntimeError("APK has no Capacitor appId")
    return directory / "app.apk", app_id


def wait_for_workspace(client, children, broker_errors, deadline, log):
    deadline = min(deadline, time.monotonic() + 60)
    last_observation = "No workspace UI observed"

    def labels(nodes):
        for node in nodes:
            if node.get("text"):
                yield node["text"]
            if node.get("content-desc"):
                yield node["content-desc"]
            yield from labels(node.get("children", []))

    while time.monotonic() < deadline:
        ensure_running(children)
        client.check()
        if broker_errors:
            raise broker_errors[0]
        try:
            result = client.request("tools/call", {"name": "ui_hierarchy", "arguments": {}},
                                    timeout=deadline - time.monotonic())
            require_tool_success(result, "inspect startup workspace")
            observation = json.loads(result["content"][0]["text"])
            if observation.get("exit_code") or observation.get("timed_out") or observation.get("truncated"):
                raise RuntimeError(f"Incomplete UI observation: {observation}")
            visible = set(labels(json.loads(observation["stdout"])))
            last_observation = json.dumps(sorted(visible))
            if {"Conversation workspace ready", "Send message"}.issubset(visible) and not visible.intersection({"Conversation workspace connecting", "Connect to workspace", "Connecting…", "Reconnect", "Retry disconnect", "piop could not connect", "Retry"}):
                return
        except TimeoutError as error:
            last_observation = str(error)
            break
        except (RuntimeError, ValueError, KeyError, TypeError) as error:
            last_observation = str(error)
        log.write(("Waiting for connected workspace: " + last_observation[:2048] + "\n").encode())
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"Piop did not show a connected workspace within the startup readiness deadline. Last observation: {last_observation[:2048]}. See {log.name}")


def piop_env(instance):
    shared_env = {key: value for key, value in os.environ.items() if key != MARKER}
    sdk = shared_env.get("ANDROID_HOME") or shared_env.get("ANDROID_SDK_ROOT") or str(Path.home() / "Android/Sdk")
    shared_env.update(ANDROID_HOME=sdk, ANDROID_SDK_ROOT=sdk, VITE_PIOP_DEBUG="true")
    shared_env["JAVA_HOME"] = java_home(shared_env)
    return shared_env, {**shared_env, MARKER: instance}


def launch_arguments(endpoint, app_id):
    arguments = {**endpoint["exec"], "argv": list(endpoint["exec"]["argv"])}
    arguments["argv"][4] = f"{app_id}/.MainActivity"
    return arguments


# MCP server

BROKER = Path(os.environ.get("ANDROID_VM_BROKER", str(Path.home() / "Projects/android-vm-broker/android-vm-broker"))).expanduser()
LAUNCH_OPTIONS = {
    "description": "Build a Piop worktree and its debug daemon, start the debug app in a private Android VM, connect it to the daemon, wait for the connected workspace, and keep it running for the mobile-piop MCP tools.",
    "inputSchema": {"type": "object", "additionalProperties": False, "required": ["project"], "properties": {
        "project": {"type": "string", "description": "Absolute Piop worktree directory"},
        "timeout_sec": {"type": "number", "exclusiveMinimum": 0, "default": 1800, "description": "Setup and rebuild deadline"},
    }},
}


def build_options(arguments):
    """Check launch arguments and return them as build options."""
    project = Path(arguments.get("project") or "").expanduser()
    if not project.is_absolute():
        raise ValueError("project must be an absolute path")
    project = project.resolve(strict=True)
    if not (project / "scripts/mobile-debug-connection.mjs").is_file():
        raise ValueError("This worktree needs Piop's mobile debug connection support")
    timeout = float(arguments.get("timeout_sec") or 1800)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout_sec must be positive and finite")
    return SimpleNamespace(project=project, apk=None, timeout=timeout,
                           gradle_init=Path(__file__).with_name("android-debug-build.gradle"))


def call(client, tool, arguments, deadline):
    result = client.request("tools/call", {"name": tool, "arguments": arguments}, timeout=remaining(deadline, 360))
    require_tool_success(result, tool)
    return result


class Session:
    """One Piop debug app in one private broker VM."""

    def __init__(self, options):
        self.options = options
        self.directory = Path(tempfile.mkdtemp(prefix="debug-", dir=runtime_root()))
        self.instance = str(uuid.uuid4())
        self.marker = f"{MARKER}={self.instance}".encode()
        self.shared_env, self.build_env = piop_env(self.instance)
        self.children = []
        self.workers = []
        self.broker_errors = []
        self.stopped = threading.Event()
        self.client = self.process = None
        self.app_id = None
        self.reinstall_lock = threading.Lock()
        self.log = open(self.directory / "setup.log", "ab", buffering=0)
        self.broker_log = open(self.directory / "broker.log", "ab", buffering=0)

    def check(self):
        ensure_running(self.children)
        self.client.check()
        if self.broker_errors:
            raise self.broker_errors[0]

    def start(self):
        options, log, children = self.options, self.log, self.children
        deadline = time.monotonic() + options.timeout
        CACHE.mkdir(parents=True, exist_ok=True, mode=0o700)
        broker_ready = Future()
        daemon_ready = Future()
        print(f"Acquiring a private Android VM from android-vm-broker. Logs: {self.directory}", file=sys.stderr, flush=True)
        self.process = subprocess.Popen([sys.executable, str(BROKER), "mcp"], cwd=options.project,
                                        env=self.shared_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.broker_log, start_new_session=True)
        children.append(("Android broker lease", self.process))
        self.client = McpClient(self.process, "Android broker")

        def boot_vm():
            try:
                broker_ready.set_result(initialize(self.client, NAME, remaining(deadline, 360)))
                # Keep the lease alive while the app runs.
                while not self.stopped.wait(15):
                    self.client.request("ping", timeout=360)
            except Exception as error:
                if not broker_ready.done():
                    broker_ready.set_exception(error)
                elif not self.stopped.is_set():
                    self.broker_errors.append(error)

        def build_daemon():
            try:
                daemon_lock = options.project / "target" / ".piop-daemon-launch.lock"
                daemon_lock.parent.mkdir(parents=True, exist_ok=True)
                with file_lock(daemon_lock, deadline):
                    run_step(["node", "scripts/build-daemon.mjs", "--debug"], env=self.build_env, cwd=options.project,
                             log=log, children=children, deadline=deadline, label="Building this worktree's debug daemon.")
                    if self.stopped.is_set():
                        raise RuntimeError("Setup cancelled")
                    daemon_ready.set_result(connection(options, self.shared_env, log, deadline))
            except Exception as error:
                daemon_ready.set_exception(error)

        worker = threading.Thread(target=boot_vm, daemon=True)
        self.workers.append(worker)
        worker.start()
        key = hashlib.sha256(str(options.project).encode()).hexdigest()[:24]
        with file_lock(CACHE / f"setup-{key}.lock", deadline):
            run_step(["npm", "run", "setup:dependencies"], env=self.build_env, cwd=options.project, log=log,
                     children=children, deadline=deadline, label="Preparing worktree dependencies.")
            worker = threading.Thread(target=build_daemon, daemon=True)
            self.workers.append(worker)
            worker.start()
            apk, app_id = prepare_apk(options, self.build_env, self.directory, log, children, deadline)
            endpoint = daemon_ready.result(timeout=remaining(deadline))
        broker_ready.result(timeout=remaining(deadline))
        self.check()
        print("Installing Piop and connecting it to the worktree daemon.", file=sys.stderr, flush=True)
        call(self.client, "install_app", {"apks": [str(apk)]}, deadline)
        call(self.client, "exec", launch_arguments(endpoint, app_id), deadline)
        wait_for_workspace(self.client, children, self.broker_errors, deadline, log)
        self.app_id = app_id
        return {"apk": str(apk), "appId": app_id, "url": endpoint["url"], "runtime": endpoint.get("runtime"),
                "logs": str(self.directory)}

    def reinstall(self):
        if not self.reinstall_lock.acquire(blocking=False):
            raise RuntimeError("A reinstall is already running")
        try:
            options = self.options
            deadline = time.monotonic() + options.timeout
            target = Path(tempfile.mkdtemp(prefix="reinstall-", dir=self.directory))
            # Build processes carry the instance marker, so stop also ends them.
            children = []
            key = hashlib.sha256(str(options.project).encode()).hexdigest()[:24]
            with file_lock(CACHE / f"setup-{key}.lock", deadline):
                run_step(["npm", "run", "setup:dependencies"], env=self.build_env, cwd=options.project, log=self.log,
                         children=children, deadline=deadline, label="Preparing worktree dependencies.")
                run_step(["node", "scripts/build-daemon.mjs", "--debug"], env=self.build_env, cwd=options.project,
                         log=self.log, children=children, deadline=deadline, label="Building this worktree's debug daemon.")
                endpoint = connection(options, self.shared_env, self.log, deadline)
                apk, new_app_id = prepare_apk(options, self.build_env, target, self.log, children, deadline)
            if new_app_id != self.app_id:
                raise RuntimeError(f"New APK is {new_app_id}, but this session runs {self.app_id}")
            call(self.client, "install_app", {"apks": [str(apk)]}, deadline)
            call(self.client, "exec", launch_arguments(endpoint, self.app_id), deadline)
            return {"apk": str(apk), "appId": self.app_id, "url": endpoint["url"]}
        finally:
            self.reinstall_lock.release()

    def call_tool(self, name, arguments):
        self.check()
        if name == "reinstall":
            return text_result(self.reinstall())
        if name == "app_state":
            return app_stater(self.client, self.app_id)(name, arguments)
        return self.client.request("tools/call", {"name": name, "arguments": arguments}, timeout=360)

    def close(self):
        if self.stopped.is_set():
            return
        self.stopped.set()
        if self.client:
            self.client.close()
        if self.process:
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.process.wait(timeout=10)
        stop_children(self.children, self.marker)
        for worker in self.workers:
            worker.join(timeout=2)
        self.log.close()
        self.broker_log.close()
        print(f"Instance stopped. Logs retained at {self.directory}", file=sys.stderr, flush=True)


def text_result(value, error=False):
    return {"content": [{"type": "text", "text": value if isinstance(value, str) else json.dumps(value)}], "isError": error}


def list_tools():
    broker_tools = runpy.run_path(str(BROKER), run_name="android_vm_broker_tools")["TOOLS"]
    return [*broker_tools, APP_STATE_TOOL, REINSTALL_TOOL]


@contextlib.contextmanager
def open_session(options):
    session = Session(options)
    try:
        yield session, list_tools()
    finally:
        session.close()


def check_host():
    if sys.platform != "linux":
        raise RuntimeError("This script supports Linux only")


def cli_arguments(argv):
    """Read launch flags from the MCP server command. Each LAUNCH_OPTIONS property is one flag."""
    parser = argparse.ArgumentParser(description=LAUNCH_OPTIONS["description"])
    properties = LAUNCH_OPTIONS["inputSchema"]["properties"]
    for name, spec in properties.items():
        flag, kind, help_text = "--" + name.replace("_", "-"), spec.get("type"), spec.get("description")
        if kind == "boolean":
            parser.add_argument(flag, dest=name, action="store_true", help=help_text)
        elif kind == "array" and name == "command":
            parser.add_argument(flag, dest=name, type=shlex.split, help=help_text)
        elif kind == "array":
            parser.add_argument(flag, dest=name, action="append", help=f"{help_text} (repeatable)")
        elif kind == "object":
            parser.add_argument(flag, dest=name, action="append", metavar="KEY=VALUE", help=f"{help_text} (repeatable)")
        elif kind == "number":
            parser.add_argument(flag, dest=name, type=float, help=help_text)
        else:
            parser.add_argument(flag, dest=name, help=help_text)
    arguments = vars(parser.parse_args(argv))
    for name, spec in properties.items():
        if spec.get("type") == "object" and arguments[name]:
            pairs = [item.partition("=") for item in arguments[name]]
            if any(not key or not separator for key, separator, _ in pairs):
                parser.error(f"--{name.replace('_', '-')} needs KEY=VALUE")
            arguments[name] = {key: value for key, _, value in pairs}
    # Codex starts MCP servers in the chat's working directory.
    arguments["project"] = str(Path(arguments["project"] or Path.cwd()).expanduser().resolve())
    return {name: value for name, value in arguments.items() if value not in (None, False)}


class Server:
    """MCP server on stdio for one running app. Codex closes stdin to stop it."""

    def __init__(self, session, tools, summary):
        self.session = session
        self.tools = tools
        self.names = {tool["name"] for tool in tools}
        self.instructions = f"These tools act on the app that this server started and keeps running: {json.dumps(summary)}"
        self.write_lock = threading.Lock()

    def send(self, message):
        with self.write_lock:
            sys.stdout.write(json.dumps(message) + "\n")
            sys.stdout.flush()

    def handle(self, message):
        method = message.get("method")
        params = message.get("params") or {}
        try:
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                          "serverInfo": {"name": NAME, "version": "1.0.0"}, "instructions": self.instructions}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": self.tools}
            elif method == "tools/call":
                name = params.get("name")
                if name not in self.names:
                    raise McpError({"code": -32602, "message": f"Unknown tool: {name}"})
                try:
                    result = self.session.call_tool(name, params.get("arguments") or {})
                except McpError:
                    raise
                except Exception as error:
                    result = text_result(f"{type(error).__name__}: {error}", error=True)
            else:
                raise McpError({"code": -32601, "message": f"Unsupported method: {method}"})
            response = {"jsonrpc": "2.0", "id": message["id"], "result": result}
        except McpError as error:
            response = {"jsonrpc": "2.0", "id": message["id"], "error": error.error}
        self.send(response)

    def serve(self):
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            if not isinstance(message, dict) or "id" not in message or "method" not in message:
                continue
            threading.Thread(target=self.handle, args=(message,), daemon=True).start()


def main():
    """Start the app first and answer Codex only when it is ready, so its tools exist only then."""
    check_host()

    def interrupted(signum, _frame):
        for sig in STOP_SIGNALS:
            signal.signal(sig, signal.SIG_IGN)
        raise Shutdown(signum)

    for sig in STOP_SIGNALS:
        signal.signal(sig, interrupted)
    options = build_options(cli_arguments(sys.argv[1:]))
    with open_session(options) as (session, tools):
        summary = session.start()
        print(json.dumps({"status": "ready", **summary}), file=sys.stderr, flush=True)
        Server(session, tools, summary).serve()


if __name__ == "__main__":
    try:
        main()
    except Shutdown as stop:
        sys.exit(stop.code)
