#!/usr/bin/env python3
"""MCP server: start a Piop worktree's Tauri dev app with WebKitWebDriver and serve WDIO MCP tools attached to it."""

import argparse
import contextlib
import shlex
import fcntl
import json
import math
import os
from pathlib import Path
import queue
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import urllib.error
import urllib.request
import uuid


NAME = "piop-wdio"
STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
MCP_COMMAND = ["npx", "-y", "@wdio/mcp@3.12.0"]
ALLOWED_TOOLS = {
    "click_element", "scroll", "set_value", "tap_element", "swipe",
    "drag_and_drop", "execute_script", "get_elements", "get_screenshot",
}


class PortConflict(Exception):
    pass


class Shutdown(BaseException):
    def __init__(self, signum):
        self.code = 128 + signum


class McpError(Exception):
    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message", str(error)))


class McpClient:
    def __init__(self, process):
        self.process = process
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
        failure = "WDIO MCP disconnected"
        try:
            for line in self.process.stdout:
                message = json.loads(line)
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    raise RuntimeError("Invalid JSON-RPC output from WDIO MCP")
                if "method" in message:
                    if "id" in message:
                        self.send({"jsonrpc": "2.0", "id": message["id"], "error": {
                            "code": -32601, "message": "This client does not provide sampling, roots, or elicitation",
                        }})
                    continue
                with self.state_lock:
                    response_queue = self.pending.pop(message.get("id"), None)
                if response_queue is not None:
                    response_queue.put(message)
        except Exception as error:
            failure = f"WDIO MCP transport failed: {error}"
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
            raise TimeoutError("Another MCP call is still running")
        request_id = str(uuid.uuid4())
        response_queue = queue.Queue()
        try:
            if time.monotonic() >= deadline:
                raise TimeoutError("MCP call expired before it could be sent")
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
                raise TimeoutError("MCP call timed out; inspect the app before retrying an interaction") from error
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


def start_mcp(directory, stderr):
    return subprocess.Popen(
        MCP_COMMAND, cwd=directory,
        env={
            **os.environ,
            # WDIO's logger binds console methods before MCP redirects them.
            # Keep diagnostic output out of the JSON-RPC stdout stream.
            "WDIO_LOG_PATH": str(directory / f"webdriver-{os.getpid()}.log"),
        },
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
        start_new_session=True,
    )


def require_tool_success(result, operation):
    if not isinstance(result, dict) or result.get("isError"):
        raise RuntimeError(f"{operation} failed: {json.dumps(result)}")


def runtime_root():
    root = Path(tempfile.gettempdir()) / f"tauri-webdriver-{os.getuid()}"
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Expected a private directory owned by this user: {root}")
    return root


@contextlib.contextmanager
def reserve_port(root):
    # Keep the file lock through shutdown, including the socket handoff to the child.
    # Other launchers cannot reuse this port during a slow build or app restart.
    for _ in range(256):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        lease = None
        try:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            lease = os.open(root / f"port-{port}.lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            yield port, listener
            return
        finally:
            listener.close()
            if lease is not None:
                os.close(lease)
    raise RuntimeError("Could not reserve an unused port")


def has_marker(pid, marker):
    try:
        return marker in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return False


def owned_pids(marker):
    return [entry.name for entry in Path("/proc").iterdir() if entry.name.isdigit() and has_marker(entry.name, marker)]


def port_ready(port, marker):
    inodes = set()
    for line in Path("/proc/net/tcp").read_text().splitlines()[1:]:
        fields = line.split()
        address, number = fields[1].split(":")
        if fields[3] == "0A" and int(number, 16) == port and address in ("0100007F", "00000000"):
            inodes.add(f"socket:[{fields[9]}]")
    if not inodes:
        return False
    for pid in owned_pids(marker):
        try:
            descriptors = list(Path(f"/proc/{pid}/fd").iterdir())
        except OSError:
            continue
        for descriptor in descriptors:
            try:
                if os.readlink(descriptor) in inodes:
                    return True
            except OSError:
                pass
    raise PortConflict(f"Port {port} was bound by a process outside this instance")


def ensure_running(children):
    for name, child in children:
        code = child.poll()
        if code is not None:
            raise RuntimeError(f"{name} exited with status {code}")


def wait_for_port(port, marker, children, deadline):
    while time.monotonic() < deadline:
        if port_ready(port, marker):
            ensure_running(children)
            return
        ensure_running(children)
        time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for port {port}")


def webdriver_request(port, route, *, method="GET", payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{route}", data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    # Local automation must not go through an inherited HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"WebDriver {method} {route}: HTTP {error.code}: {detail[:2000]}") from error
    if not isinstance(result, dict):
        raise RuntimeError("WebDriver returned an invalid response")
    value = result.get("value")
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(f"WebDriver: {value}")
    return result


def signal_owned(marker, signum):
    for pid in owned_pids(marker):
        try:
            # Recheck immediately before signaling to avoid acting on a stale PID.
            if has_marker(pid, marker):
                os.kill(int(pid), signum)
        except ProcessLookupError:
            pass


def stop_children(children, marker):
    # Give supervisors time to stop before sweeping descendants, including daemons
    # and watchers that created new process groups.
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


def app_environment(args, directory, instance_id):
    env = dict(os.environ)
    env["TAURI_WEBDRIVER_INSTANCE"] = instance_id
    env["TAURI_WEBVIEW_AUTOMATION"] = "true"
    env["TAURI_AUTOMATION"] = "true"
    if not args.shared_profile:
        original_home = Path.home()
        home = directory / "home"
        home.mkdir(mode=0o700)
        for name in ("PIOP_TEST_HOME", "PIOP_DAEMON_URL", "PIOP_DAEMON_TOKEN", "PI_CODING_AGENT_SESSION_DIR"):
            env.pop(name, None)
        env.update({
            "HOME": str(home),
            "PI_CODING_AGENT_DIR": str(home / ".pi" / "agent"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "XDG_STATE_HOME": str(home / ".local" / "state"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "PIOP_MOBILE_BIND": "127.0.0.1:0",
            "CARGO_HOME": env.get("CARGO_HOME", str(original_home / ".cargo")),
            "RUSTUP_HOME": env.get("RUSTUP_HOME", str(original_home / ".rustup")),
        })
        if "XAUTHORITY" not in env and (original_home / ".Xauthority").is_file():
            env["XAUTHORITY"] = str(original_home / ".Xauthority")
    return env


def acquire_daemon_launch_lock(project, deadline):
    """Wait for other Piop launchers to finish building and connecting this worktree's daemon."""
    path = Path(project) / "target" / ".piop-daemon-launch.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(lock)
                raise TimeoutError("Another Piop launcher kept this worktree's daemon lock past the startup deadline")
            time.sleep(0.2)


def connected_runtime(driver_port, session_id, timeout):
    script = """
const done = arguments[arguments.length - 1];
let finished = false;
const finish = result => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(result);
};
const timer = setTimeout(() => finish({runtimeError: "Timed out reading daemon runtime information"}), arguments[0]);
Promise.resolve().then(() => window.__TAURI_INTERNALS__.invoke("daemon_invoke", {
    command: "debug_runtime", args: {}
})).then(runtime => finish({runtime}), error => finish({runtimeError: String(error)}));
"""
    try:
        result = webdriver_request(driver_port, f"/session/{session_id}/execute/async", method="POST",
                                   payload={"script": script, "args": [max(100, int((timeout - 1) * 1000))]}, timeout=timeout)
        value = result.get("value")
        if not isinstance(value, dict):
            raise RuntimeError("Daemon returned no runtime information")
        return value
    except Exception as error:
        return {"runtimeError": str(error)}


# MCP server

LAUNCH_OPTIONS = {
    "description": "Start a Piop worktree's Tauri desktop app in development mode with WebKitWebDriver, attach WDIO to it, and keep it running for the piop-wdio MCP tools.",
    "inputSchema": {"type": "object", "additionalProperties": False, "required": ["project"], "properties": {
        "project": {"type": "string", "description": "Project or worktree directory; defaults to the current directory"},
        "command": {"type": "array", "items": {"type": "string"}, "minItems": 1,
                    "description": "App command run in project; replaces the default npm run tauri dev"},
        "isolated_profile": {"type": "boolean", "default": False,
                             "description": "Use a clean temporary home directory without the user's provider credentials or running daemon"},
        "browser_name": {"type": "string", "default": "wry"},
        "timeout_sec": {"type": "number", "exclusiveMinimum": 0, "default": 600, "description": "Startup deadline"},
    }},
}


def launch_options(arguments):
    """Check launch arguments and return them as options."""
    project = Path(arguments.get("project") or "").expanduser()
    if not project.is_absolute():
        raise ValueError("project must be an absolute path")
    project = project.resolve(strict=True)
    if not project.is_dir():
        raise ValueError("project must be a directory")
    timeout = float(arguments.get("timeout_sec") or 600)
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout_sec must be positive and finite")
    driver = shutil.which("WebKitWebDriver")
    if not driver:
        raise RuntimeError("WebKitWebDriver was not found; install it")
    return SimpleNamespace(
        project=project, command=list(arguments.get("command") or ["npm", "run", "tauri", "dev"]),
        shared_profile=not arguments.get("isolated_profile", False),
        browser_name=arguments.get("browser_name") or "wry", timeout=timeout, driver=driver)


class Session:
    """One Tauri app with its WebKitWebDriver session, attached to the server's WDIO MCP."""

    def __init__(self, options, wdio):
        self.options = options
        self.wdio = wdio
        self.root = runtime_root()
        self.directory = Path(tempfile.mkdtemp(prefix="instance-", dir=self.root))
        self.instance = str(uuid.uuid4())
        self.marker = f"TAURI_WEBDRIVER_INSTANCE={self.instance}".encode()
        self.children = []
        self.resources = contextlib.ExitStack()
        self.session_id = self.driver_port = None
        self.attached = False
        self.closed = False

    def check(self):
        ensure_running(self.children)
        self.wdio.check()

    def start(self):
        options = self.options
        env = app_environment(options, self.directory, self.instance)
        deadline = time.monotonic() + options.timeout
        print(f"Starting the app. Logs and profile: {self.directory}", file=sys.stderr, flush=True)
        for attempt in range(3):
            try:
                return self.start_once(env, deadline)
            except PortConflict as error:
                if attempt == 2 or time.monotonic() >= deadline:
                    raise
                print(f"{error}; retrying with new ports.", file=sys.stderr, flush=True)
                self.stop_processes()
                self.resources.close()
                self.resources = contextlib.ExitStack()

    def start_once(self, env, deadline):
        options, resources, children = self.options, self.resources, self.children
        inspector_port, inspector_socket = resources.enter_context(reserve_port(self.root))
        self.driver_port, driver_socket = resources.enter_context(reserve_port(self.root))
        app_command = options.command
        app_log = resources.enter_context(open(self.directory / "app.log", "ab", buffering=0))
        driver_log = resources.enter_context(open(self.directory / "driver.log", "ab", buffering=0))
        address = f"127.0.0.1:{inspector_port}"
        driver_socket.close()
        driver_env = {**os.environ, "TAURI_WEBDRIVER_INSTANCE": self.instance}
        driver_env.pop("WEBDRIVER_TARGET_ADDR", None)
        children.append(("WebKitWebDriver", subprocess.Popen(
            [options.driver, "--host=127.0.0.1", f"--port={self.driver_port}", f"--target={address}"],
            cwd=options.project, env=driver_env, stdin=subprocess.DEVNULL,
            stdout=driver_log, stderr=subprocess.STDOUT, start_new_session=True)))
        wait_for_port(self.driver_port, self.marker, children, min(deadline, time.monotonic() + 15))
        if webdriver_request(self.driver_port, "/status", timeout=2).get("value", {}).get("ready") is not True:
            raise RuntimeError("WebKitWebDriver is not ready for a session")
        inspector_socket.close()
        # Other Piop launchers must not build or connect this worktree's daemon at the same time.
        daemon_lock = acquire_daemon_launch_lock(options.project, deadline)
        resources.callback(os.close, daemon_lock)
        children.append(("App launcher", subprocess.Popen(
            app_command, cwd=options.project, env={**env, "WEBKIT_INSPECTOR_SERVER": address}, stdin=subprocess.DEVNULL,
            stdout=app_log, stderr=subprocess.STDOUT, start_new_session=True)))
        wait_for_port(inspector_port, self.marker, children, deadline)
        value = webdriver_request(self.driver_port, "/session", method="POST", payload={
            "capabilities": {"alwaysMatch": {"browserName": options.browser_name}, "firstMatch": [{}]},
        }, timeout=remaining(deadline, 30)).get("value", {})
        if not isinstance(value, dict) or not isinstance(value.get("sessionId"), str) or not value["sessionId"]:
            raise RuntimeError("WebKitWebDriver did not return a session ID")
        self.session_id = value["sessionId"]
        ensure_running(children)
        connection = {"protocol": "http", "hostname": "127.0.0.1", "port": self.driver_port, "path": "/"}
        require_tool_success(self.wdio.request("tools/call", {"name": "attach_session", "arguments": {
            "provider": "external", "platform": "browser", "sessionId": self.session_id, "webdriverConfig": connection,
            "capabilities": value.get("capabilities", {"browserName": options.browser_name})}},
            timeout=remaining(deadline, 30)), "attach_session")
        self.attached = True
        runtime = connected_runtime(self.driver_port, self.session_id, min(15, max(1, deadline - time.monotonic())))
        fcntl.flock(daemon_lock, fcntl.LOCK_UN)
        return {"project": str(options.project), "logs": str(self.directory), "profileHome": env.get("HOME"),
                "appCommand": app_command, **runtime}

    def call_tool(self, name, arguments):
        self.check()
        return self.wdio.request("tools/call", {"name": name, "arguments": arguments})

    def stop_processes(self):
        if self.attached:
            with contextlib.suppress(Exception):
                self.wdio.request("tools/call", {"name": "close_session", "arguments": {"detach": True}}, timeout=5)
            self.attached = False
        if self.session_id and self.children and self.children[0][1].poll() is None:
            with contextlib.suppress(Exception):
                webdriver_request(self.driver_port, f"/session/{self.session_id}", method="DELETE", timeout=2)
        self.session_id = None
        stop_children(self.children, self.marker)
        self.children.clear()

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.stop_processes()
        self.resources.close()
        print(f"Instance stopped. Logs and profile retained at {self.directory}", file=sys.stderr, flush=True)


def remaining(deadline, maximum=None):
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("Startup deadline expired")
    return left if maximum is None else min(left, maximum)


def text_result(value, error=False):
    return {"content": [{"type": "text", "text": value if isinstance(value, str) else json.dumps(value)}], "isError": error}


def start_wdio(log):
    process = start_mcp(runtime_root(), log)
    client = McpClient(process)
    try:
        client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                      "clientInfo": {"name": NAME, "version": "1.0.0"}}, timeout=120)
        client.notify("notifications/initialized")
        tools = [tool for tool in client.request("tools/list", timeout=30)["tools"] if tool["name"] in ALLOWED_TOOLS]
        missing = ALLOWED_TOOLS - {tool["name"] for tool in tools}
        if missing:
            raise RuntimeError(f"WDIO MCP lacks tools: {sorted(missing)}")
    except BaseException:
        stop_wdio(process, client)
        raise
    return process, client, tools


def stop_wdio(process, client):
    client.close()
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=5)




@contextlib.contextmanager
def open_session(options):
    with open(runtime_root() / f"wdio-{os.getpid()}.log", "ab", buffering=0) as log:
        process, client, tools = start_wdio(log)
        session = Session(options, client)
        try:
            yield session, tools
        finally:
            session.close()
            stop_wdio(process, client)


def check_host():
    if sys.platform != "linux":
        raise RuntimeError("This script requires Linux and WebKitWebDriver")
    if not shutil.which(MCP_COMMAND[0]):
        raise RuntimeError("npx was not found; install Node.js and npm to start WDIO MCP")


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
    options = launch_options(cli_arguments(sys.argv[1:]))
    with open_session(options) as (session, tools):
        summary = session.start()
        print(json.dumps({"status": "ready", **summary}), file=sys.stderr, flush=True)
        Server(session, tools, summary).serve()


if __name__ == "__main__":
    try:
        main()
    except Shutdown as stop:
        sys.exit(stop.code)
