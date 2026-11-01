#!/usr/bin/env python3
"""Build a Piop worktree, run its connected debug app in a private android-vm-broker VM, and serve its Android CLI tools."""

import argparse
import base64
import contextlib
from concurrent.futures import Future
import fcntl
import hashlib
import json
import secrets
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile

NAME = "mobile-piop"
MARKER = "MOBILE_PIOP_INSTANCE"
STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
REINSTALL_TOOL = {
    "name": "reinstall",
    "description": "Rebuild this worktree's debug daemon and app, then install and start the app in this VM. Use after code changes.",
    "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
}
INSTRUCTIONS = ("The app runs in this launcher's private Android VM. The tools act on its screen through Android CLI. "
                "Call reinstall after code changes.")


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
            if has_marker(pid, marker):
                os.kill(int(pid), signum)
        except ProcessLookupError:
            pass


def stop_children(children, marker):
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


class McpError(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message", str(error)))


class McpClient:
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


def forward(client, timeout=360):
    return lambda name, arguments: client.request("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)


class ToolServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path, initialized, instructions, routes):
        self.tools = {}
        for tools, handler in routes:
            for tool in tools:
                if tool["name"] in self.tools:
                    raise RuntimeError(f"Two tools are named {tool['name']}")
                self.tools[tool["name"]] = (tool, handler)
        self.initialized = {**initialized, "capabilities": {"tools": {}}, "instructions": instructions}
        super().__init__(str(path), ToolHandler)
        self.thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
        self.thread.start()

    def dispatch(self, message):
        method = message.get("method")
        params = message.get("params", {})
        if not isinstance(params, dict):
            raise McpError({"code": -32602, "message": "params must be an object"})
        if "id" not in message:
            return None
        if method == "initialize":
            return self.initialized
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [tool for tool, _ in self.tools.values()]}
        if method == "tools/call":
            entry = self.tools.get(params.get("name"))
            if entry is None:
                return {"isError": True, "content": [{"type": "text", "text": f"Unknown tool: {params.get('name')}"}]}
            return entry[1](params["name"], params.get("arguments") or {})
        raise McpError({"code": -32601, "message": f"Unsupported method: {method}"})

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=1)
        Path(self.server_address).unlink(missing_ok=True)


class ToolHandler(socketserver.StreamRequestHandler):
    def handle(self):
        for line in self.rfile:
            message = None
            try:
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    raise McpError({"code": -32600, "message": "Invalid JSON-RPC request"})
                result = self.server.dispatch(message)
                if "id" not in message:
                    continue
                response = {"jsonrpc": "2.0", "id": message["id"], "result": result}
            except Exception as error:
                detail = error.error if isinstance(error, McpError) else {"code": -32000, "message": str(error)}
                response = {"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None, "error": detail}
            try:
                self.wfile.write((json.dumps(response) + "\n").encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return


def bridge_request(connection, method, params):
    request_id = str(uuid.uuid4())
    connection.sendall((json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n").encode())
    with connection.makefile("rb") as responses:
        line = responses.readline()
    if not line:
        raise RuntimeError("The launcher disconnected")
    response = json.loads(line)
    if response.get("id") != request_id:
        raise RuntimeError("MCP response ID did not match the request")
    if "error" in response:
        raise McpError(response["error"])
    return response["result"]


def relay_stdio(connection):
    connection.settimeout(None)

    def send_input():
        try:
            while chunk := sys.stdin.buffer.read1(65536):
                connection.sendall(chunk)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                connection.shutdown(socket.SHUT_WR)

    threading.Thread(target=send_input, daemon=True).start()
    while chunk := connection.recv(65536):
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()


def run_client_command(mode):
    parser = argparse.ArgumentParser(prog=f"{Path(__file__).name} {mode}")
    parser.add_argument("--session", required=True, type=Path, help="sessionFile printed by the launcher")
    if mode == "call":
        parser.add_argument("tool")
        parser.add_argument("arguments", nargs="?", default="{}", help="Tool arguments as JSON")
    elif mode == "tools":
        parser.add_argument("tool", nargs="?", help="Show only this tool's schema")
    args = parser.parse_args(sys.argv[2:])
    session_file = args.session.expanduser().resolve(strict=True)
    manifest = json.loads(session_file.read_text())
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(manifest["mcpSocket"])
        if mode == "connect":
            relay_stdio(connection)
            return
        if mode == "call":
            arguments = json.loads(args.arguments)
            if not isinstance(arguments, dict):
                parser.error("Tool arguments must be a JSON object")
            result = bridge_request(connection, "tools/call", {"name": args.tool, "arguments": arguments})
        else:
            result = bridge_request(connection, "tools/list", {})
            if args.tool:
                result = {**result, "tools": [tool for tool in result.get("tools", []) if tool["name"] == args.tool]}
                if not result["tools"]:
                    raise RuntimeError(f"Unknown tool: {args.tool}")
    result_id = str(uuid.uuid4())
    result_file = session_file.parent / f"result-{result_id}.json"
    result_file.write_text(json.dumps(result, indent=2) + "\n")
    displayed = json.loads(json.dumps(result))
    for index, part in enumerate(displayed.get("content", [])):
        if part.get("type") == "image":
            extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}.get(part.get("mimeType"), ".bin")
            image_file = session_file.parent / f"image-{result_id}-{index}{extension}"
            image_file.write_bytes(base64.b64decode(part["data"], validate=True))
            displayed["content"][index] = {"type": "text", "text": f"Image saved to {image_file}"}
    print(json.dumps({"resultFile": str(result_file), "result": displayed}, indent=2))
    if result.get("isError"):
        sys.exit(1)


def sdk_root(env=os.environ):
    for candidate in (env.get("ANDROID_HOME"), env.get("ANDROID_SDK_ROOT"), str(Path.home() / "Android/Sdk")):
        if candidate and Path(candidate).expanduser().is_dir():
            return Path(candidate).expanduser().resolve()
    raise RuntimeError("Android SDK not found; set ANDROID_HOME")


APP_STATE_TOOL = {
    "name": "app_state",
    "description": "Report whether a package is not_installed, not_running, background, or foreground. Defaults to the launched app.",
    "inputSchema": {"type": "object", "properties": {"package": {"type": "string", "minLength": 1}}, "additionalProperties": False},
}


def observe(client, argv, deadline):
    result = client.request("tools/call", {"name": "exec", "arguments": {"argv": argv}}, timeout=remaining(deadline, 60))
    try:
        observation = json.loads(result["content"][0]["text"])
        code = observation["exit_code"]
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise RuntimeError(f"{argv[0]} failed in the VM: {json.dumps(result)[:1000]}") from error
    if observation.get("timed_out") or observation.get("truncated") or code not in (0, 1):
        raise RuntimeError(f"{argv[0]} failed in the VM: {json.dumps(observation)[:1000]}")
    return code, observation.get("stdout", "")


def last_exit(dump, package):
    for record in dump.split("ApplicationExitInfo #")[1:]:
        fields = dict(re.findall(r"(\w+)=(\S+(?: \([^)]*\))?)", record))
        if fields.get("process") == package:
            description = re.search(r"description=(.*?) state=", record)
            return {"time": re.search(r"timestamp=(\S+ \S+)", record).group(1), "reason": fields.get("reason"),
                    "subreason": fields.get("subreason"), "description": description.group(1) if description else None}
    return None


def app_stater(client, app_id):
    def app_state(_name, arguments):
        deadline = time.monotonic() + 60
        package = arguments.get("package") or app_id
        report = {"package": package}
        code, _ = observe(client, ["/system/bin/pm", "path", package], deadline)
        if code:
            report.update(state="not_installed", pids=[])
        else:
            _, activities = observe(client, ["/system/bin/sh", "-c", "dumpsys activity activities | grep ResumedActivity"], deadline)
            resumed = set(re.findall(r" ([\w.]+)/", activities))
            _, found = observe(client, ["/system/bin/ps", "-A", "-o", "PID,NAME"], deadline)
            pids = [int(pid) for pid, name in (line.split(None, 1) for line in found.splitlines()[1:] if line.strip())
                    if name.strip() == package or name.strip().startswith(package + ":")]
            report.update(state="foreground" if package in resumed else "background" if pids else "not_running", pids=pids)
            if report["state"] == "not_running":
                _, exits = observe(client, ["/system/bin/dumpsys", "activity", "exit-info", package], deadline)
                report["lastExit"] = last_exit(exits, package)
        return {"content": [{"type": "text", "text": json.dumps(report)}]}

    return app_state


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--resume", type=Path, help="Reuse the owner token from a previous session file")
    parser.add_argument("--broker", type=Path, default=Path(os.environ.get("ANDROID_VM_BROKER", str(Path.home() / "Projects/android-vm-broker/android-vm-broker"))))
    parser.add_argument("--timeout", type=float, default=1800, help="Setup deadline in seconds")
    args = parser.parse_args()
    args.project = args.project.expanduser().resolve(strict=True)
    args.broker = args.broker.expanduser().resolve(strict=True)
    if not (args.project / "scripts/mobile-debug-connection.mjs").is_file():
        parser.error("This worktree needs Piop's mobile debug connection support")
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be positive and finite")
    args.apk = None
    args.gradle_init = Path(__file__).with_name("android-debug-build.gradle")
    return args


def connection(args, env, log, deadline):
    for attempt in range(2):
        try:
            result = subprocess.run(["node", "scripts/mobile-debug-connection.mjs"], cwd=args.project,
                                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log,
                                    text=True, timeout=remaining(deadline, 60))
            if result.returncode == 0:
                return json.loads(result.stdout)
        except subprocess.TimeoutExpired:
            print("Worktree daemon connection timed out; retrying once after stopping it.", file=sys.stderr, flush=True)
        if attempt == 0:
            print("Restarting this worktree's debug daemon to use its rebuilt binary.", file=sys.stderr, flush=True)
            daemon = next((path for path in (args.project / "target/debug/piopd",) if path.is_file()), None)
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
        project_key = hashlib.sha256(str(args.project).encode()).hexdigest()[:24]
        with file_lock(runtime_root() / f"build-{project_key}.lock", deadline):
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


def wait_for_workspace(client, children, broker_errors, deadline, log, endpoint, app_id):
    deadline = min(deadline, time.monotonic() + 180)
    last_observation = "No workspace UI observed"
    recovered_dependency = False
    ready_since = None

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
            if {"Conversation workspace ready", "Send message"}.issubset(visible) and not visible.intersection({"Conversation workspace connecting", "Connect to workspace", "Connecting…", "Reconnect", "Retry disconnect", "piop could not connect"}):
                if ready_since is None:
                    ready_since = time.monotonic()
                elif time.monotonic() - ready_since >= 60:
                    return
            else:
                ready_since = None
        except TimeoutError as error:
            last_observation = str(error)
            break
        except (RuntimeError, ValueError, KeyError, TypeError) as error:
            ready_since = None
            last_observation = str(error)
        state = json.loads(app_stater(client, app_id)("app_state", {})["content"][0]["text"])
        if state["state"] == "not_running":
            reason = (state.get("lastExit") or {}).get("reason", "unknown")
            if reason == "12 (DEPENDENCY DIED)" and not recovered_dependency:
                recovered_dependency = True
                ready_since = None
                print("Android stopped Piop after a system dependency died; relaunching once.", file=sys.stderr, flush=True)
                call(client, "exec", launch_arguments(endpoint, app_id), deadline)
            else:
                raise RuntimeError(f"Piop stopped during startup: {json.dumps(state)}; see {log.name}")
        log.write(("Waiting for connected workspace: " + last_observation[:2048] + "\n").encode())
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"Piop did not show a connected workspace within the startup readiness deadline. Last observation: {last_observation[:2048]}. See {log.name}")


def call(client, tool, arguments, deadline):
    result = client.request("tools/call", {"name": tool, "arguments": arguments}, timeout=remaining(deadline, 360))
    require_tool_success(result, tool)
    return result


def labels(nodes):
    for node in nodes:
        for key in ("text", "content-desc"):
            if node.get(key):
                yield node[key]
        yield from labels(node.get("children", []))


def visible_labels(client, deadline):
    result = call(client, "ui_hierarchy", {}, deadline)
    observation = json.loads(result["content"][0]["text"])
    if observation.get("exit_code") or observation.get("timed_out") or observation.get("truncated"):
        raise RuntimeError(f"Incomplete UI observation: {json.dumps(observation)[:2048]}")
    return set(labels(json.loads(observation["stdout"])))


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


def reinstaller(args, directory, client, app_id, shared_env, build_env, log):
    lock = threading.Lock()

    def reinstall(_name, _arguments):
        if not lock.acquire(blocking=False):
            raise RuntimeError("A reinstall is already running")
        try:
            deadline = time.monotonic() + args.timeout
            target = Path(tempfile.mkdtemp(prefix="reinstall-", dir=directory))
            children = []
            key = hashlib.sha256(str(args.project).encode()).hexdigest()[:24]
            with file_lock(runtime_root() / f"setup-{key}.lock", deadline):
                run_step(["npm", "run", "setup:dependencies"], env=build_env, cwd=args.project, log=log,
                         children=children, deadline=deadline, label="Preparing worktree dependencies.")
                run_step(["node", "scripts/build-daemon.mjs", "--debug"], env=build_env, cwd=args.project, log=log,
                         children=children, deadline=deadline, label="Building this worktree's debug daemon.")
                endpoint = connection(args, shared_env, log, deadline)
                apk, new_app_id = prepare_apk(args, build_env, target, log, children, deadline)
            if new_app_id != app_id:
                raise RuntimeError(f"New APK is {new_app_id}, but this session runs {app_id}")
            print("Installing the new build and launching it in the same VM.", file=sys.stderr, flush=True)
            call(client, "install_app", {"apks": [str(apk)]}, deadline)
            call(client, "exec", launch_arguments(endpoint, app_id), deadline)
            wait_for_workspace(client, [], [], deadline, log, endpoint, app_id)
            return {"content": [{"type": "text", "text": json.dumps({"apk": str(apk), "appId": app_id, "url": endpoint["url"]})}]}
        finally:
            lock.release()

    return reinstall


def save_session(path, manifest):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            json.dump(manifest, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def owner_session(args, directory):
    if args.resume:
        saved = json.loads(args.resume.expanduser().resolve(strict=True).read_text())
        if Path(saved["project"]).resolve() != args.project:
            raise ValueError("The saved session belongs to a different project")
        token = saved["ownerToken"]
    else:
        token = os.environ.get("ANDROID_VM_BROKER_OWNER_TOKEN", secrets.token_hex(32))
    if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("Owner token must contain 64 lowercase hexadecimal characters")
    saved = {"project": str(args.project), "ownerToken": token, "sessionFile": str(directory / "session.json")}
    save_session(directory / "session.json", saved)
    return saved


def launch(args, directory):
    ownership = owner_session(args, directory)
    deadline = time.monotonic() + args.timeout
    instance = str(uuid.uuid4())
    marker = f"{MARKER}={instance}".encode()
    shared_env, build_env = piop_env(instance)
    children = []
    client = server = process = None
    stopped = threading.Event()
    workers = []
    broker_ready = Future()
    daemon_ready = Future()
    broker_errors = []
    with open(directory / "setup.log", "ab", buffering=0) as log, open(directory / "broker.log", "ab", buffering=0) as broker_log:
        try:
            print("Acquiring a private Android VM from android-vm-broker.", file=sys.stderr, flush=True)
            process = subprocess.Popen([sys.executable, str(args.broker), "mcp"], cwd=args.project,
                                       env={**shared_env, "ANDROID_VM_BROKER_OWNER_TOKEN": ownership["ownerToken"]}, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=broker_log, start_new_session=True)
            children.append(("Android broker lease", process))
            client = McpClient(process, "Android broker")

            def boot_vm():
                try:
                    initialized = initialize(client, NAME, remaining(deadline, 360))
                    tools = client.request("tools/list", timeout=remaining(deadline, 30))["tools"]
                    broker_ready.set_result((initialized, tools))
                    while not stopped.wait(15):
                        client.request("ping", timeout=360)
                except Exception as error:
                    if not broker_ready.done():
                        broker_ready.set_exception(error)
                    else:
                        broker_errors.append(error)

            worker = threading.Thread(target=boot_vm, daemon=True)
            workers.append(worker)
            worker.start()
            key = hashlib.sha256(str(args.project).encode()).hexdigest()[:24]
            with file_lock(runtime_root() / f"setup-{key}.lock", deadline):
                run_step(["npm", "run", "setup:dependencies"], env=build_env, cwd=args.project, log=log,
                         children=children, deadline=deadline, label="Preparing worktree dependencies.")

                def build_daemon():
                    try:
                        if stopped.is_set():
                            raise RuntimeError("Setup cancelled")
                        daemon_lock = args.project / "target" / ".piop-daemon-launch.lock"
                        daemon_lock.parent.mkdir(parents=True, exist_ok=True)
                        with file_lock(daemon_lock, deadline):
                            run_step(["node", "scripts/build-daemon.mjs", "--debug"], env=build_env, cwd=args.project,
                                     log=log, children=children, deadline=deadline,
                                     label="Building this worktree's debug daemon.")
                            if stopped.is_set():
                                raise RuntimeError("Setup cancelled")
                            daemon_ready.set_result(connection(args, shared_env, log, deadline))
                    except Exception as error:
                        daemon_ready.set_exception(error)

                worker = threading.Thread(target=build_daemon, daemon=True)
                workers.append(worker)
                worker.start()
                apk, app_id = prepare_apk(args, build_env, directory, log, children, deadline)
                endpoint = daemon_ready.result(timeout=remaining(deadline))

            initialized, native_tools = broker_ready.result(timeout=remaining(deadline))
            print("Installing Piop and connecting it to the worktree daemon.", file=sys.stderr, flush=True)
            call(client, "install_app", {"apks": [str(apk)]}, deadline)
            call(client, "exec", launch_arguments(endpoint, app_id), deadline)
            print("Waiting for Piop's connected workspace UI.", file=sys.stderr, flush=True)
            wait_for_workspace(client, children, broker_errors, deadline, log, endpoint, app_id)
            server = ToolServer(directory / "mcp.sock", initialized, INSTRUCTIONS, [
                (native_tools, forward(client)),
                ([APP_STATE_TOOL], app_stater(client, app_id)),
                ([REINSTALL_TOOL], reinstaller(args, directory, client, app_id, shared_env, build_env, log)),
            ])
            session_file = directory / "session.json"
            manifest = {
                "ownerToken": ownership["ownerToken"],
                "project": str(args.project), "instanceId": instance, "launcherPid": os.getpid(),
                "apk": str(apk), "appId": app_id, "url": endpoint["url"], "runtime": endpoint.get("runtime"),
                "sessionFile": str(session_file), "mcpSocket": str(directory / "mcp.sock"),
                "logs": {name: str(directory / f"{name}.log") for name in ("setup", "broker")},
                "mcp": {"command": sys.executable, "args": [str(Path(__file__).resolve()), "connect", "--session", str(session_file)]},
            }
            save_session(session_file, manifest)
            print(json.dumps(manifest, indent=2), flush=True)
            print("Ready: use this sessionFile for tools and calls. Keep this launcher running.", file=sys.stderr, flush=True)
            while not stopped.wait(0.5):
                ensure_running(children)
                client.check()
                if broker_errors:
                    raise broker_errors[0]
        finally:
            handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in STOP_SIGNALS}
            try:
                stopped.set()
                if server:
                    server.close()
                if client:
                    client.close()
                if process:
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=10)
                stop_children(children, marker)
                for worker in workers:
                    worker.join(timeout=2)
                save_session(directory / "session.json", ownership)
            finally:
                for sig, handler in handlers.items():
                    signal.signal(sig, handler)
            print(f"Instance stopped. Logs and results retained at {directory}", file=sys.stderr, flush=True)


def main():
    if sys.platform != "linux":
        raise RuntimeError("This launcher supports Linux only")
    args = parse_args()
    directory = Path(tempfile.mkdtemp(prefix="debug-", dir=runtime_root()))
    print(f"Instance logs: {directory}", file=sys.stderr, flush=True)

    def interrupted(signum, _frame):
        raise Shutdown(signum)

    for sig in STOP_SIGNALS:
        signal.signal(sig, interrupted)
    launch(args, directory)


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] in ("call", "tools", "connect"):
            run_client_command(sys.argv[1])
        else:
            main()
    except Shutdown as error:
        sys.exit(error.code)
    except Exception as error:
        print(f"{NAME}: {error}", file=sys.stderr)
        sys.exit(1)
