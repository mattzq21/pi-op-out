"""Exercise the real WDIO MCP transport against a minimal WebDriver endpoint."""

import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import tempfile
import threading
import unittest


launcher = runpy.run_path(str(Path(__file__).resolve().parents[1] / "tauri-webdriver.py"))


class WebDriverFixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        values = {
            "/session/fixture/window": "window-1",
            "/session/fixture/window/handles": ["window-1"],
            "/session/fixture/title": "Fixture",
            "/session/fixture/url": "about:blank",
        }
        if self.path not in values:
            self.send_error(404)
            return
        self.send_value(values[self.path])

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if self.path != "/session/fixture/window":
            self.send_error(404)
            return
        self.send_value(None)

    def send_value(self, value):
        body = json.dumps({"value": value}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class CapturedStdout:
    def __init__(self, stream):
        self.stream = stream
        self.lines = []

    def __iter__(self):
        for line in self.stream:
            self.lines.append(line)
            yield line

    def close(self):
        self.stream.close()


class WdioStdioTest(unittest.TestCase):
    def test_attach_and_inspect_preserves_jsonrpc_stdout(self):
        driver = ThreadingHTTPServer(("127.0.0.1", 0), WebDriverFixture)
        driver_thread = threading.Thread(target=driver.serve_forever, daemon=True)
        driver_thread.start()
        directory = tempfile.TemporaryDirectory(prefix="wdio-mcp-regression-")
        process = launcher["start_mcp"](Path(directory.name), "wdio-mcp-regression", subprocess.DEVNULL)
        captured = CapturedStdout(process.stdout)
        process.stdout = captured
        client = launcher["McpClient"](process)
        try:
            client.request("initialize", {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "wdio-stdio-regression", "version": "1.0.0"},
            }, timeout=15)
            client.notify("notifications/initialized")
            for name, arguments in (
                ("attach_session", {
                    "provider": "external", "platform": "browser", "sessionId": "fixture",
                    "webdriverConfig": {"protocol": "http", "hostname": "127.0.0.1", "port": driver.server_port, "path": "/"},
                    "capabilities": {"browserName": "wry"},
                }),
                ("get_tabs", {}),
            ):
                result = client.request("tools/call", {"name": name, "arguments": arguments}, timeout=10)
                launcher["require_tool_success"](result, name)
            self.assertIn("Fixture", json.dumps(result))
            for line in captured.lines:
                self.assertEqual(json.loads(line).get("jsonrpc"), "2.0")
            self.assertIn("COMMAND", (Path(directory.name) / "webdriver.log").read_text())
        except Exception:
            # This fixture uses synthetic data and no credentials.
            for line in captured.lines:
                try:
                    json.loads(line)
                except ValueError:
                    print(f"Invalid MCP stdout: {line.decode(errors='replace').rstrip()}", flush=True)
            raise
        finally:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            client.close()
            driver.shutdown()
            driver.server_close()
            driver_thread.join(timeout=1)
            directory.cleanup()


if __name__ == "__main__":
    unittest.main()
