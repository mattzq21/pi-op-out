import { lazy } from "solid-js";
import { isMobile } from "../lib/platform";

export interface TerminalViewProps {
  visible?: boolean;
  ownershipRequired?: boolean; onTakeOwnership?: () => Promise<void>;
  inputDraft?: string; onDraft: (value: string) => void;
  onResize?: (cols: number, rows: number) => Promise<void>;
  cwd?: string; terminals: { id: string; label: string }[]; activeId: string; output: string; outputEnd: number; snapshot?: string; snapshotEnd?: number; started: boolean; exited?: boolean;
  onAdd: () => void; onSelect: (id: string) => void; onStart: (id: string, cols: number, rows: number) => void;
  onData: (data: string, clearDraft?: boolean, userInput?: boolean) => Promise<boolean>; onSnapshot: (value: string, outputEnd: number) => void; onDelete: () => void; onClose: () => void;
}

const ClientTerminalView = lazy(() => isMobile
  ? import("./MobileTerminalView").then(module => ({ default: module.MobileTerminalView }))
  : import("./DesktopTerminalView").then(module => ({ default: module.DesktopTerminalView })));

export function TerminalView(props: TerminalViewProps) {
  return <ClientTerminalView {...props} />;
}
