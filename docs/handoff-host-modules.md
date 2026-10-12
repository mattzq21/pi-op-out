# Handoff: replace host scripts with daemon modules

Status: decision recorded; code changes have not started. Implement [ADR 0003](adr/0003-host-operations-as-daemon-modules.md).

## Current code

- `daemon/resources/host-scripts.json` lists all 11 helpers. Use it as the conversion checklist.
- `daemon/src/host_script.ts` selects local execution or SSH, copies script text to a file, starts a separate program, and handles replies and failures.
- `daemon/src/mobile_commands.ts` calls `peers.route()` before local command handling. `daemon/src/peers.ts` already forwards remote requests and changes their host ID to `local` at the destination. Session lists and storage reports also use that connection.
- The callers are `archives.ts`, `session_index.ts`, `session_registry.ts`, `storage_transactions.ts`, `project_files.ts`, `host/agents.ts`, and `host/reference_publication.ts`, under `daemon/src/`.
- Some internal paths still select remote script execution directly. For example, `session_groups.ts` calls `Registry.idsOn()` for remote hosts. Trace these paths separately from app request routing.

## Work

1. Trace every helper caller through the current command routing. Remove unused remote branches and route needed remote operations through `peers.ts`. Each operation must execute on the host that owns its data, including requests from Android through the anchor host.
2. Convert each helper into a module with explicit inputs, return values, and errors. Replace stdin/stdout request wrappers. Keep request and result validation at the request boundary.
3. Use direct asynchronous calls for suitable file operations. Put blocking or heavy operations in worker threads. Verify worker loading from the built daemon; workers must use packaged code without extracting host scripts. Bound concurrent work and handle worker failure, shutdown, and cancellation.
4. Replace `daemon/resources/storage-transaction-lock.cjs`, which currently restarts the script while holding file locks. Preserve lock order, nonblocking busy results, and protection shared with other writers. Inspect `file-lock.cjs` and `storage-lock.cjs` before choosing the replacement. A lock used only inside one daemon cannot replace a lock also used by other programs.
5. Refactor agent loading before calling it as a module. `agent-definitions-command.cjs` changes environment variables, the working directory, arguments, and stdout, then exits the process. `extensions/piop-define-agents/daemon-loader.ts` reads those values at load time. Replace this with explicit inputs and results; check repeated loads and extension validation in workers.
6. Preserve storage transaction results, recovery records, and restore receipts. A timeout or lost connection can leave the result unknown. Keep that distinction from a confirmed failure, and avoid automatic retries of writes with unknown results.
7. Remove `host_script.ts`, obsolete command wrappers, the script manifest and generated script bundles once their callers are converted. Update `daemon/src/resources.ts` and `scripts/build-extensions.mjs`; retain build outputs still used elsewhere. Remove copying, hashing for copied-script names, touching copies, cleanup of copies, and direct SSH execution of these helpers. Do not keep a fallback to the old path.

## Completion checks

- All 11 helpers are converted or removed because no caller needs them. Search for remaining uses of `runHostScript`, `HOST_SCRIPT_BUNDLES`, and the copied `host-scripts` directory; inspect each match.
- Build the daemon and verify worker loading from the built executable, not only from source files.
- Check local and remote session listing, storage reports, archive/delete/restore, project relocation, missing-folder recovery, temporary chat creation/removal, chat group cleanup, image reads, agent loading/reloading, and goal reference checks.
- Test conflicting storage writes, busy locks, worker failure, daemon restart during a write, and remote disconnect during a write. Confirm recovery and error reporting, and confirm locks are released.
- With a large storage operation running, confirm the daemon still handles another request. Verify remote operations use the existing daemon connection and create no copied helper scripts, including when no old copies exist.
- Check the affected flows on Linux and Android. Report the checks run and any remaining limits.
