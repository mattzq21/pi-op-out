# Run host operations as daemon modules

Accepted and implemented on 2026-10-12.

The daemons already have a connection for remote requests. Convert the host scripts into normal modules bundled with the daemon, and send remote requests through that existing connection to the daemon on the host that owns the data. Remove script copying, content-based script filenames, and script-copy cleanup.

Call modules directly when their work can run without blocking the daemon. Use worker threads for blocking or heavy work; a worker thread runs code separately while the daemon handles other requests. Adding `async` to a function does not make synchronous work stop blocking.

Replace the storage lock code that restarts a script. Preserve protection against conflicting writes, recovery after a crash, and clear reporting when an operation's result is unknown. Pass inputs explicitly instead of changing process-wide settings. Workers must load bundled modules without creating script copies on the host.

Implementation details and completion checks are in the [handoff](../handoff-host-modules.md).
