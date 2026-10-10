# Storage transactions do not take per-session owner locks

Storage transactions (archive, delete and restore) use only the profile storage lock (`storage-transaction-lock.cjs`) and the reference publication lock. We removed the per-session owner locks (`transaction-owner-locks.cjs`): restore always gave an empty session list, only blank-session delete took one, no code checks those lock files, and the Rust daemon marks busy sessions before it calls Node.

## Considered Options

- Take an owner lock for each session in each transaction. Rejected: these locks add files that no reader checks, so they give no protection.
