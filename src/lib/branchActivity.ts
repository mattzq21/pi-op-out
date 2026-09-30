import { createSignal } from "solid-js";

const [pendingBranches, setPendingBranches] = createSignal(0);
export const isBranching = () => pendingBranches() > 0;

export function beginBranching() {
  setPendingBranches(count => count + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    setPendingBranches(count => count - 1);
  };
}
