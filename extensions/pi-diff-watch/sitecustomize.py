"""File snapshots for one Piop shell command, loaded by Python's site."""


def _install():
    import json
    import os
    import stat
    import sys
    import threading
    import time
    import hashlib
    from functools import wraps

    root = os.environ.get("PIOP_DIFF_JOURNAL")
    if not root or not os.path.isabs(root) or not os.path.isdir(root):
        return
    local = threading.local()
    max_file = 1024 * 1024
    max_total = 8 * max_file
    lock = os.path.join(root, "lock")
    state_path = os.path.join(root, "state.json")
    attempted = set()

    def read_bytes(path, limit):
        metadata = os.lstat(path)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError("not a small regular file")
        flags = (
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        )
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("not a regular file")
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("oversized file")
        return data

    def write_private(path, data):
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(path, flags, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)

    def skipped_path(path):
        return os.path.join(root, "skipped-" + hashlib.sha256(path.encode("utf-8")).hexdigest())

    def unavailable(path=None):
        markers = [os.path.join(root, "incomplete")]
        if path is not None:
            markers.append(skipped_path(path))
        for marker in markers:
            try:
                write_private(marker, b"")
            except OSError:
                pass  # Already marked or the journal has expired.

    def acquire_lock(path):
        deadline = time.monotonic() + 0.1
        while True:
            try:
                os.mkdir(lock)
                return True
            except OSError as error:
                if not isinstance(error, FileExistsError) or time.monotonic() >= deadline:
                    unavailable(path)
                    return False
                # Yield to other threads before allowing the original write.
                time.sleep(0.002)

    def snapshot(path, follow=True):
        if not isinstance(path, (str, bytes)):
            return  # An existing file descriptor has no reliable original path.
        path = os.fsdecode(path)
        if not path:
            return
        parent, name = os.path.split(path)
        path = os.path.realpath(path) if follow else os.path.join(os.path.realpath(parent or "."), name)
        if path.startswith(root + os.sep):
            return
        if path in attempted:
            return
        if not acquire_lock(path):
            attempted.add(path)
            return
        try:
            if path in attempted:
                return
            if len(attempted) >= 32:
                unavailable(path)
                return
            if os.path.exists(skipped_path(path)):
                return
            try:
                state = json.loads(read_bytes(state_path, 256 * 1024))
            except FileNotFoundError:
                state = {"paths": [], "bytes": 0}
            paths = state["paths"]
            if path in paths:
                return
            if len(paths) >= 32:
                unavailable(path)
                return
            content = None
            skip = False
            try:
                content = read_bytes(path, max_file)
                if b"\0" in content:
                    skip = True
                    content = None
                else:
                    content = content.decode("utf-8")
            except FileNotFoundError:
                pass
            except Exception:
                content = None
                skip = True
            record = json.dumps(
                {"path": path, "content": content, "skip": skip, "capturedAt": time.time() * 1000}, ensure_ascii=False
            ).encode("utf-8")
            if state["bytes"] + len(record) > max_total:
                unavailable(path)
                return
            # Publish a complete record before updating the shared index. A
            # killed writer leaves either a complete baseline or no baseline.
            temporary = os.path.join(root, "pending.json")
            write_private(temporary, record)
            os.replace(temporary, os.path.join(root, str(len(paths)) + ".json"))
            paths.append(path)
            state["bytes"] += len(record)
            write_private(
                temporary, json.dumps(state, ensure_ascii=False).encode("utf-8")
            )
            os.replace(temporary, state_path)
        except Exception:
            unavailable(path)
        finally:
            attempted.add(path)
            os.rmdir(lock)

    def path_at(path, directory_fd):
        path = os.fsdecode(path)
        if directory_fd in (-1, None) or os.path.isabs(path):
            return path
        expected = os.fstat(directory_fd)
        if not stat.S_ISDIR(expected.st_mode):
            raise OSError("Descriptor is not a directory")
        for descriptors in ("/proc/self/fd", "/dev/fd"):
            try:
                directory = os.readlink(os.path.join(descriptors, str(directory_fd)))
                if not os.path.isabs(directory):
                    continue
                actual = os.stat(directory)
                if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
                    continue
                return os.path.join(directory, path)
            except OSError:
                continue
        raise OSError("Could not resolve the directory descriptor")

    def snapshot_at(path, directory_fd, follow=False):
        try:
            snapshot(path_at(path, directory_fd), follow=follow)
        except Exception:
            # Keep the operation working when this platform cannot resolve an fd.
            unavailable()

    def snapshot_move(source, destination, source_fd, destination_fd):
        try:
            pending = [(path_at(source, source_fd), path_at(destination, destination_fd))]
        except Exception:
            unavailable()
            snapshot_at(source, source_fd)
            snapshot_at(destination, destination_fd)
            return
        deadline = time.monotonic() + 2
        entries = 0
        while pending:
            if entries >= 4096 or time.monotonic() >= deadline:
                unavailable()
                break
            entries += 1
            source_path, destination_path = pending.pop()
            try:
                if stat.S_ISDIR(os.lstat(source_path).st_mode):
                    with os.scandir(source_path) as directory:
                        while True:
                            if len(pending) + entries >= 4096 or time.monotonic() >= deadline:
                                unavailable()
                                break
                            child = next(directory, None)
                            if child is None:
                                break
                            pending.append((
                                os.path.join(source_path, child.name),
                                os.path.join(destination_path, child.name),
                            ))
                else:
                    # lstat keeps directory symlinks out of the traversal.
                    snapshot(source_path, follow=False)
                    snapshot(destination_path, follow=False)
            except Exception:
                unavailable()

    def audit_hook(event, args):
        if getattr(local, "active", False):
            return
        local.active = True
        try:
            if event == "open":
                path, mode, flags = args
                if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                    snapshot(path)
            elif event == "os.remove":
                path, directory_fd = args
                snapshot_at(path, directory_fd)
            elif event == "os.rename":
                source, destination, source_fd, destination_fd = args
                snapshot_move(source, destination, source_fd, destination_fd)
        except Exception:
            # Observation failures must not change the user's operation.
            pass
        finally:
            local.active = False

    original_open = os.open

    @wraps(original_open)
    def open_at(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is None or getattr(local, "active", False):
            return original_open(path, flags, mode, dir_fd=dir_fd)
        # The open audit event omits dir_fd. Capture here and prevent that event
        # from recording a misleading baseline relative to the working directory.
        local.active = True
        try:
            try:
                if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC):
                    snapshot_at(path, dir_fd, follow=not (flags & getattr(os, "O_NOFOLLOW", 0)))
            except Exception:
                unavailable()
            return original_open(path, flags, mode, dir_fd=dir_fd)
        finally:
            local.active = False

    sys.addaudithook(audit_hook)
    audit_hook = None  # The registered function still works.
    os.open = open_at
    # shutil.rmtree and other callers select fd-based operations by membership.
    if original_open in os.supports_dir_fd:
        os.supports_dir_fd.add(open_at)


def _load_existing_sitecustomize():
    import importlib.machinery
    import importlib.util
    import os
    import sys

    root = os.path.dirname(os.path.abspath(__file__))
    # Keep the user's existing startup customization and normal import path.
    sys.path[:] = [entry for entry in sys.path if os.path.abspath(entry) != root]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", sys.path)
    if spec is not None and spec.loader is not None:
        module = importlib.util.module_from_spec(spec)
        sys.modules["sitecustomize"] = module
        spec.loader.exec_module(module)


try:
    _load_existing_sitecustomize()
finally:
    try:
        _install()
    except Exception:
        pass
