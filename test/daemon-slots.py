"""Holds daemon slots for one test daemon until stdin closes.

Usage: daemon-slots.py DIRECTORY SIZE NEED wait|try

The slots are SIZE lock files in DIRECTORY, shared by every test process on this machine. A holder takes NEED of them
together while it holds the gate, so two tests that need several slots never each hold part and wait for each other.
With try, it takes the slots that are free at once, up to NEED, and never waits: callers that already hold slots
use it, so a holder never waits and the slots cannot deadlock. It prints "ready" once it holds its slots and keeps
them until stdin closes. The kernel releases the locks when the holder exits, also when its test process dies.
"""
import fcntl
import os
import sys
import threading


def main():
    directory, size, need, mode = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    if size < 1 or need < 1:
        raise SystemExit('Slot size and need must be positive')
    if mode not in ('wait', 'try'):
        raise SystemExit('Mode must be wait or try')
    need = min(need, size)
    os.makedirs(directory, exist_ok=True)
    if mode == 'try':
        taken = []
        for index in range(size):
            if len(taken) == need:
                break
            slot = open(os.path.join(directory, 'slot-%d' % index), 'a')
            try:
                fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
                taken.append(slot)
            except BlockingIOError:
                slot.close()
        print('ready', flush=True)
        sys.stdin.buffer.read()
        os._exit(0)
    gate = open(os.path.join(directory, 'gate'), 'a')
    fcntl.flock(gate, fcntl.LOCK_EX)
    held = []
    changed = threading.Condition()

    def wait_for(index):
        slot = open(os.path.join(directory, 'slot-%d' % index), 'a')
        fcntl.flock(slot, fcntl.LOCK_EX)
        with changed:
            if len(held) < need:
                held.append(slot)
                changed.notify()
                return
        # Taken after enough slots were held: give it back at once.
        slot.close()

    # One waiter per slot, so the first slots that become free are taken, whichever they are.
    for index in range(size):
        threading.Thread(target=wait_for, args=(index,), daemon=True).start()
    with changed:
        while len(held) < need:
            changed.wait()
    gate.close()
    print('ready', flush=True)
    sys.stdin.buffer.read()
    # Waiters still blocked on busy slots end with the process.
    os._exit(0)


if __name__ == '__main__':
    main()
