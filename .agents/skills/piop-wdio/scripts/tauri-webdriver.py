#!/usr/bin/env python3
"""Launch a Linux Tauri dev app and attach its own WDIO MCP."""

import argparse
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import queue
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
import urllib.error
import urllib.request
import uuid


STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
MCP_COMMAND = ["npx", "-y", "@wdio/mcp@3.12.0"]
SESSION_TOOLS = {"start_session", "attach_session", "close_session", "launch_chrome"}
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


def start_mcp(directory, instance_id, stderr):
    return subprocess.Popen(
        MCP_COMMAND, cwd=directory,
        env={
            **os.environ,
            "TAURI_WEBDRIVER_INSTANCE": instance_id,
            "WDIO_LOG_PATH": str(directory / "webdriver.log"),
        },
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
        start_new_session=True,
    )


def require_tool_success(result, operation):
    if not isinstance(result, dict) or result.get("isError"):
        raise RuntimeError(f"{operation} failed: {json.dumps(result)}")


class McpBridge(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path, client, initialized):
        self.client = client
        self.initialized = {
            **initialized,
            "capabilities": {"tools": {}, "resources": {}},
            "instructions": "WDIO MCP is already attached to this launcher's Tauri app. Inspect and interact directly. The launcher owns session setup and cleanup.",
        }
        super().__init__(str(path), McpBridgeHandler)
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
            self.client.check()
            return {}
        if method == "tools/call" and params.get("name") in SESSION_TOOLS:
            return {"isError": True, "content": [{"type": "text", "text": "The launcher already attached this instance and owns its lifecycle. Stop the launcher to close it."}]}
        if method == "tools/call" and params.get("name") not in ALLOWED_TOOLS:
            return {"isError": True, "content": [{"type": "text", "text": "This tool is not enabled for this skill."}]}
        if method not in ("tools/list", "tools/call", "resources/list", "resources/templates/list", "resources/read"):
            raise McpError({"code": -32601, "message": f"Unsupported method: {method}"})
        result = self.client.request(method, params)
        if method == "tools/list":
            result = {**result, "tools": [tool for tool in result.get("tools", []) if tool["name"] in ALLOWED_TOOLS]}
        return result

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=1)
        Path(self.server_address).unlink(missing_ok=True)


class McpBridgeHandler(socketserver.StreamRequestHandler):
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
    parser.add_argument("--session", required=True, type=Path, help="sessionFile printed by this instance's launcher")
    if mode == "call":
        parser.add_argument("tool")
        parser.add_argument("arguments", nargs="?", default="{}", help="Tool arguments as JSON")
    elif mode == "tools":
        parser.add_argument("tool", nargs="?", help="Show only this tool's schema")
    args = parser.parse_args(sys.argv[2:])
    session_file = args.session.expanduser().resolve(strict=True)
    manifest = json.loads(session_file.read_text())
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(125)
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


def parse_args():
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="After startup: tools --session FILE [TOOL], call --session FILE TOOL '[JSON]', or connect --session FILE for MCP stdio.",
    )
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="Project or worktree directory")
    parser.add_argument("--driver", default="WebKitWebDriver", help="Native driver executable")
    parser.add_argument("--browser-name", default="wry")
    parser.add_argument("--timeout", type=float, default=600, help="Startup deadline in seconds")
    profile = parser.add_mutually_exclusive_group()
    profile.add_argument("--shared-profile", dest="shared_profile", action="store_true", help="Reuse the inherited app profile and potentially its existing daemon (default)")
    profile.add_argument("--isolated-profile", dest="shared_profile", action="store_false", help="Use a clean temporary app profile without inherited provider credentials")
    parser.set_defaults(shared_profile=True)
    parser.add_argument("command", nargs=argparse.REMAINDER, help="Optional app command after --; replaces the default tauri dev command")
    args = parser.parse_args()
    args.project = args.project.expanduser().resolve(strict=True)
    if not args.project.is_dir():
        parser.error("--project must be a directory")
    if not 0 < args.timeout < float("inf"):
        parser.error("--timeout must be a positive finite number")
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    return args


def runtime_root():
    root = Path(tempfile.gettempdir()) / f"tauri-webdriver-{os.getuid()}"
    root.mkdir(mode=0o700, exist_ok=True)
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Expected a private directory owned by this user: {root}")
    return root


def acquire_daemon_launch_lock(project, deadline):
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


@contextlib.contextmanager
def reserve_port(root):
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
            if has_marker(pid, marker):
                os.kill(int(pid), signum)
        except ProcessLookupError:
            pass


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


def launch(args, root, directory, instance_id):
    marker = f"TAURI_WEBDRIVER_INSTANCE={instance_id}".encode()
    env = app_environment(args, directory, instance_id)
    deadline = time.monotonic() + args.timeout
    app_command = args.command or ["npm", "run", "tauri", "dev"]
    for attempt in range(3):
        children = []
        session_id = None
        driver_port = None
        mcp_client = None
        mcp_bridge = None
        with contextlib.ExitStack() as resources:
            inspector_port, inspector_socket = resources.enter_context(reserve_port(root))
            driver_port, driver_socket = resources.enter_context(reserve_port(root))
            app_log = resources.enter_context(open(directory / "app.log", "ab", buffering=0))
            driver_log = resources.enter_context(open(directory / "driver.log", "ab", buffering=0))
            mcp_log = resources.enter_context(open(directory / "mcp.log", "ab", buffering=0))
            address = f"127.0.0.1:{inspector_port}"
            try:
                driver_socket.close()
                driver_env = {**os.environ, "TAURI_WEBDRIVER_INSTANCE": instance_id}
                driver_env.pop("WEBDRIVER_TARGET_ADDR", None)
                driver = subprocess.Popen(
                    [args.driver, "--host=127.0.0.1", f"--port={driver_port}", f"--target={address}"],
                    cwd=args.project, env=driver_env, stdin=subprocess.DEVNULL,
                    stdout=driver_log, stderr=subprocess.STDOUT, start_new_session=True,
                )
                children.append(("WebKitWebDriver", driver))
                wait_for_port(driver_port, marker, children, min(deadline, time.monotonic() + 15))
                if webdriver_request(driver_port, "/status", timeout=2).get("value", {}).get("ready") is not True:
                    raise RuntimeError("WebKitWebDriver is not ready for a session")
                inspector_socket.close()
                daemon_lock = acquire_daemon_launch_lock(args.project, deadline)
                resources.callback(os.close, daemon_lock)
                app = subprocess.Popen(
                    app_command, cwd=args.project,
                    env={**env, "WEBKIT_INSPECTOR_SERVER": address}, stdin=subprocess.DEVNULL,
                    stdout=app_log, stderr=subprocess.STDOUT, start_new_session=True,
                )
                children.append(("App launcher", app))
                wait_for_port(inspector_port, marker, children, deadline)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Startup deadline expired")
                result = webdriver_request(driver_port, "/session", method="POST", payload={
                    "capabilities": {"alwaysMatch": {"browserName": args.browser_name}, "firstMatch": [{}]},
                }, timeout=min(30, remaining))
                value = result.get("value", {})
                if not isinstance(value, dict):
                    raise RuntimeError("WebKitWebDriver did not return session details")
                session_id = value.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    raise RuntimeError("WebKitWebDriver did not return a session ID")
                ensure_running(children)
                connection = {"protocol": "http", "hostname": "127.0.0.1", "port": driver_port, "path": "/"}
                attach_arguments = {
                    "provider": "external", "platform": "browser", "sessionId": session_id,
                    "webdriverConfig": connection, "capabilities": value.get("capabilities", {"browserName": args.browser_name}),
                }
                mcp = start_mcp(directory, instance_id, mcp_log)
                children.append(("WDIO MCP", mcp))
                mcp_client = McpClient(mcp)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Startup deadline expired before MCP attachment")
                print("Starting WDIO MCP and attaching it to this app instance.", file=sys.stderr, flush=True)
                initialized = mcp_client.request("initialize", {
                    "protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "tauri-webdriver-launcher", "version": "1.0.0"},
                }, timeout=min(60, remaining))
                mcp_client.notify("notifications/initialized")
                for tool, arguments in (("attach_session", attach_arguments), ("get_tabs", {})):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Startup deadline expired during MCP attachment")
                    result = mcp_client.request("tools/call", {"name": tool, "arguments": arguments}, timeout=min(30, remaining))
                    require_tool_success(result, tool)
                ensure_running(children)
                session_file = directory / "session.json"
                socket_path = directory / "mcp.sock"
                mcp_bridge = McpBridge(socket_path, mcp_client, initialized)
                runtime = connected_runtime(driver_port, session_id, min(15, max(1, deadline - time.monotonic())))
                fcntl.flock(daemon_lock, fcntl.LOCK_UN)
                manifest = {
                    "instanceId": instance_id,
                    "project": str(args.project),
                    "launcherPid": os.getpid(),
                    "directory": str(directory),
                    "profileHome": env.get("HOME"),
                    **runtime,
                    "appCommand": app_command,
                    "inspectorAddress": address,
                    "webdriverSessionId": session_id,
                    "webdriverConfig": connection,
                    "sessionFile": str(session_file),
                    "mcpSocket": str(socket_path),
                    "mcpAttached": True,
                    "logs": {
                        "app": str(directory / "app.log"), "driver": str(directory / "driver.log"),
                        "mcp": str(directory / "mcp.log"),
                        "webdriver": str(directory / "webdriver.log"),
                    },
                    "mcp": {
                        "command": sys.executable,
                        "args": [str(Path(__file__).resolve()), "connect", "--session", str(session_file)],
                    },
                }
                serialized = json.dumps(manifest, indent=2) + "\n"
                session_file.write_text(serialized)
                print(serialized, end="", flush=True)
                print("Ready: WDIO MCP is attached. Use this script's tools/call commands with sessionFile. Keep the launcher running; Ctrl+C stops this instance.", file=sys.stderr)
                while True:
                    if app.poll() == 0:
                        return
                    ensure_running(children)
                    mcp_client.check()
                    time.sleep(0.5)
            except PortConflict as error:
                if attempt == 2 or time.monotonic() >= deadline:
                    raise
                print(f"{error}; retrying with new ports.", file=sys.stderr)
            finally:
                handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in STOP_SIGNALS}
                try:
                    try:
                        if mcp_bridge is not None:
                            mcp_bridge.close()
                        if mcp_client is not None:
                            with contextlib.suppress(Exception):
                                mcp_client.request("tools/call", {"name": "close_session", "arguments": {"detach": True}}, timeout=1)
                        if session_id and children[0][1].poll() is None:
                            with contextlib.suppress(Exception):
                                webdriver_request(driver_port, f"/session/{session_id}", method="DELETE", timeout=1)
                    finally:
                        stop_children(children, marker)
                        if mcp_client is not None:
                            mcp_client.close()
                        (directory / "session.json").unlink(missing_ok=True)
                finally:
                    for sig, handler in handlers.items():
                        signal.signal(sig, handler)


def main():
    if sys.platform != "linux":
        raise RuntimeError("This launcher requires Linux and WebKitWebDriver")
    args = parse_args()
    args.driver = shutil.which(os.path.expanduser(args.driver))
    if not args.driver:
        raise RuntimeError("WebKitWebDriver was not found; install it or pass --driver /path/to/WebKitWebDriver")
    if not shutil.which(MCP_COMMAND[0]):
        raise RuntimeError("npx was not found; install Node.js/npm to start WDIO MCP")
    root = runtime_root()
    directory = Path(tempfile.mkdtemp(prefix="instance-", dir=root))
    print(f"Instance logs and profile: {directory}", file=sys.stderr, flush=True)
    print("Building and starting the app; connection JSON will appear on stdout after WDIO MCP attaches.", file=sys.stderr, flush=True)

    def interrupted(signum, _frame):
        raise Shutdown(signum)

    for sig in STOP_SIGNALS:
        signal.signal(sig, interrupted)
    try:
        launch(args, root, directory, str(uuid.uuid4()))
    finally:
        print(f"Instance stopped. Logs and profile retained at {directory}", file=sys.stderr)


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] in ("call", "tools", "connect"):
            run_client_command(sys.argv[1])
        else:
            main()
    except Shutdown as error:
        sys.exit(error.code)
    except Exception as error:
        print(f"tauri-webdriver: {error}", file=sys.stderr)
        sys.exit(1)
