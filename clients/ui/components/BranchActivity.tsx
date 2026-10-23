import { Show } from "solid-js";
import { LoaderCircle } from "lucide-solid";
import { isBranching } from "../lib/branchActivity";
import "./branch-activity.css";

export function BranchActivity() {
  return <Show when={isBranching()}><div class="branch-activity" role="status" aria-label="Forking conversation" aria-live="polite"><LoaderCircle size={72} class="spinning" aria-hidden="true" /></div></Show>;
}
