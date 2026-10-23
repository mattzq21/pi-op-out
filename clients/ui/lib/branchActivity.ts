import { createSignal } from "solid-js";

const [pendingBranches, setPendingBranches] = createSignal(0);

const settledWaiters = new Set<() => void>();

export const isBranching = () => pendingBranches() > 0;

export function whenBranchesSettled(): Promise<void> {
  if (!isBranching()) return Promise.resolve();

  return new Promise(resolve => settledWaiters.add(resolve));
}

export function beginBranching() {
  setPendingBranches(count => count + 1);
  let finished = false;

  return () => {
    if (finished) return;
    finished = true;
    setPendingBranches(count => count - 1);

    if (!isBranching()) {
      for (const resolve of settledWaiters) resolve();
      settledWaiters.clear();
    }
  };
}
