import { createSignal, lazy, Show } from "solid-js";
import { Folder } from "lucide-solid";
import { localHostLabel } from "../lib/mobileHosts";
import { hostChoices } from "../lib/hostChoices";
import type { NativeTransport } from "../lib/nativeTransport";
import type { SessionGroup } from "../lib/sessionGroups";
import type { AppSettings } from "../types";

const ProjectDialog = lazy(() => import("./ProjectDialog").then(module => ({ default: module.ProjectDialog })));

export type GroupProject = Pick<SessionGroup, "cwd" | "hostId" | "hostName">;

interface Props {
  transport: NativeTransport;
  settings: AppSettings;
  hostId: string;
  disabled: boolean;
  project?: GroupProject;
  onSelect: (project: GroupProject) => void;
  onCancel: () => void;
}

export function GroupProjectPicker(props: Props) {
  const [open, setOpen] = createSignal(false);
  const name = () => props.project?.cwd?.split(/[\\/]/).filter(Boolean).at(-1);

  const select = async (cwd: string, hostId: string) => {
    props.onSelect({ cwd, hostId, hostName: props.settings.hosts.find(host => host.id === hostId)?.name ?? localHostLabel() });
    setOpen(false);
  };

  return <>
    <div class="project-picker group-project-picker"><button type="button" class={name() ? "selected" : undefined} data-tooltip={props.project?.cwd ?? undefined} disabled={props.disabled} onClick={() => setOpen(true)}><Folder size={14} />{name() ?? "Choose project"}</button></div>
    <Show when={open()}><ProjectDialog hosts={hostChoices(props.settings)} initialPath={props.project?.cwd ?? ""} hostId={props.project?.hostId ?? props.hostId} onHomeDirectory={hostId => props.transport.homeDirectory(hostId)} onChooseDirectory={(path, hostId) => props.transport.listDirectories(hostId, path || undefined)} onOpen={select} onCancel={() => { setOpen(false); props.onCancel(); }} /></Show>
  </>;
}
