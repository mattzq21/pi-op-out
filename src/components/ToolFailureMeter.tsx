import { Show } from "solid-js";
import type { ToolFailureStats } from "../lib/toolFailureStats";

export function ToolFailureMeter(props: { stats?: ToolFailureStats }) {
  return <Show when={props.stats}>{stats => <span class={`cache-hit-rate tool-failure-rate${stats().failed ? " low" : ""}`} tabIndex={0} aria-label={`Tool failures ${stats().rate}%, ${stats().failed}/${stats().total} completed top-level calls; detected invalid use: ${stats().invalidUse}; other or unclassified: ${stats().other}`}>
    Tool fails {stats().rate}%
    <span class="tool-failure-tooltip" aria-hidden="true">
      <span>{stats().failed}/{stats().total} completed top-level calls failed</span>
      <span>Invalid use (detected): {stats().invalidUse}</span>
      <span>Other / unclassified: {stats().other}</span>
    </span>
  </span>}</Show>;
}
