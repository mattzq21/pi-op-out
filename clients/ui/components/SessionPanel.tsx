import { required } from "../lib/required";
import { Key } from "@solid-primitives/keyed";
import { createComputed,createMemo,createSignal,Show,untrack,type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createDependencyEffect,createMemoFields,createRef,cssPixels,type KeyboardEvent,type MouseEvent } from "../lib/solid";

import { AppWindow,Archive,ChevronDown,Copy,Ellipsis,FileText,Folder,FolderOpen,LoaderCircle,MessageSquarePlus,Pencil,Search,Trash2 } from "lucide-solid";
import { openGroupDirectory } from "../lib/nativeTransport";
import { isMobile } from "../lib/platform";
import { DIRLESS_KEY, isTemporaryChatCwd, type SessionGroup } from "../lib/sessionGroups";
import { groupLayoutToken,isFixedGroup,RECENT_KEY,sessionKey,sessionLayoutToken,type DraggedSession,type SidebarState } from "../lib/sidebarState";
import type { SessionSummary } from "../types";
import { GroupProjectPicker, type GroupProject } from "./GroupProjectPicker";
import type { NativeTransport } from "../lib/nativeTransport";
import type { AppSettings } from "../types";
import { RemoveGroupDialog } from "./RemoveGroupDialog";

export type SessionAction = "split" | "new-window" | "rename" | "open-directory" | "archive" | "copy-id" | "open-rollout";


/** A chat in a project folder that the user picked, in the main worktree. A chat without a project has a temporary folder from Piop. */
const pickedProject = (session: SessionSummary) => Boolean(session.cwd) && !isTemporaryChatCwd(session.cwd) && !session.linkedWorktree;

interface Props { transport: NativeTransport; settings: AppSettings; isArchiving: (session: SessionSummary) => boolean; debug?: boolean; sidebar: SidebarState; activeId?: string; activeHostId?: string; runningSessions?: ReadonlySet<string>; unseenSessions?: ReadonlySet<string>; query: string; onQuery: (query: string) => void; onSelect: (session: SessionSummary) => NativeTransport | undefined; onAction: (session: SessionSummary, action: SessionAction) => void; onNewChat: (group: SessionGroup) => void; createGroupRequest?: number; onCreateGroupHandled?: () => void; newChatRequest?: number; }

type CustomGroup = SessionGroup;

interface DropTarget { projectKey: string; sessionKey: string; edge: "before" | "after"; layoutBefore?: string | null; parentKey?: string; }

type DraggedItem = DraggedSession | { projectKey: string };

type MouseDrag = DraggedItem & { startX: number; startY: number; active: boolean; };

const TOUCH_HOLD_MS = 800;
const TOUCH_SCROLL_SLOP = 8;

function isBlockedDirlessTarget(drag: MouseDrag, target?: DropTarget) {
  return target?.projectKey === DIRLESS_KEY && !("session" in drag && drag.projectKey === DIRLESS_KEY && target.sessionKey);
}

const actions: ReadonlyArray<readonly [SessionAction, typeof AppWindow, string]> = [
  ["new-window", AppWindow, "Open in new window"], ["rename", Pencil, "Rename conversation"], ["open-directory", FolderOpen, "Open project directory"], ["copy-id", Copy, "Copy session ID"], ["open-rollout", FileText, "Open rollout file"]
];

function directoryLabel(session: SessionSummary) {
  return session.cwdExists === false ? "Directory unavailable" : "Project directory";
}

function disclosureId(key: string) {
  return `project-${[...new TextEncoder().encode(key)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function formatApiCost(cost = 0) {
  if (cost > 0 && cost < .01) return `$${cost.toFixed(3)}`;

  return `$${cost.toFixed(2)}`;
}

function sessionPanelDefaults({ debug = false, sidebar, activeId, activeHostId = "local", runningSessions = new Set(), unseenSessions = new Set(), query, onQuery, onSelect, onAction, onNewChat, createGroupRequest = 0, onCreateGroupHandled, newChatRequest = 0 }: Props) {
  return { debug, sessions: sidebar.sessions(), activeId, activeHostId, runningSessions, unseenSessions, query, onQuery, onSelect, onAction, onNewChat, createGroupRequest, onCreateGroupHandled, newChatRequest };
}

function groupLabel(project: string, hostId: string, hostName: string | undefined) {
  return !hostId || hostId === "local" ? project : `${hostName ?? hostId} / ${project}`;
}

export function SessionPanel(props: Props) {
  const panelFields = createMemoFields(() => sessionPanelDefaults(props));
  const panel = () => panelFields;
  const storedGroups = props.sidebar;
  const { collapsedProjects, customGroupsByKey, groupDestination, projectDetails, normalizedQuery, visualProjectKey, filtered, groups, sidebarEntries, validateGroupName, saveGroup, removeGroup, toggleProject, expandProject, moveSession, placeSidebarEntry } = storedGroups;
  const { projectParent, canMoveProject, moveProject, groupEntries, placeGroupEntry } = storedGroups;
  const siblingEntries = (parent?: string) => sidebarEntries().filter(token => projectParent(token.slice("group:".length)) === parent);

  const keyboardSidebarEntries = createMemo(() => {
    const descendants = (parent?: string): string[] => siblingEntries(parent).flatMap(token => [token, ...descendants(token.slice("group:".length))]);

    return descendants();
  });

  const [menu, setMenu] = createSignal<{ session: SessionSummary; x: number; y: number; returnFocus?: HTMLElement }>();
  const [groupMenu, setGroupMenu] = createSignal<{ projectKey: string; label: string; x: number; y: number; returnFocus: HTMLElement }>();
  const [removingGroup, setRemovingGroup] = createSignal<{ id: string; name: string }>();
  const [groupSaving, setGroupSaving] = createSignal(false);
  const groupSavePending = createRef(false);
  const [groupActionError, setGroupActionError] = createSignal<string>();
  const [groupProject, setGroupProject] = createSignal<GroupProject>();
  const [newGroupName, setNewGroupName] = createSignal<string>();
  const [editingGroupId, setEditingGroupId] = createSignal<string>();
  const [groupDraftError, setGroupDraftError] = createSignal<string>();
  const [draggedSession, setDraggedSession] = createSignal<DraggedSession>();
  const [draggedProject, setDraggedProject] = createSignal<string>();
  const [dropTarget, setDropTarget] = createSignal<DropTarget>();
  const menuRef = createRef<HTMLDivElement>(null);
  const searchRef = createRef<HTMLInputElement>(null);
  const groupNameRef = createRef<HTMLInputElement>(null);
  const groupDraftActive = createRef(false);
  const mouseDragRef = createRef<MouseDrag | undefined>(undefined);
  const mouseDropTargetRef = createRef<DropTarget | undefined>(undefined);
  const suppressClickRef = createRef<string | undefined>(undefined);
  const sessionScrollRef = createRef<HTMLDivElement>(null);
  const autoScrollFrameRef = createRef<number | undefined>(undefined);
  const dragPointerRef = createRef<{ x: number; y: number } | undefined>(undefined);
  const groupedSessionsRef = createRef<Map<string, SessionSummary[]>>(new Map());
  createComputed(() => { groupedSessionsRef.current = storedGroups.groupedSessions(); });
  const removeMouseListenersRef = createRef<() => void>(() => { });
  const touchHoldRef = createRef(false);

  const closeMenu = (restoreFocus = false) => { const target = groupMenu()?.returnFocus ?? menu()?.returnFocus; setMenu(undefined); setGroupMenu(undefined);

    if (restoreFocus) requestAnimationFrame(() => target?.focus()); };

  createDependencyEffect(() => { const capturedMenu = menu(); const capturedGroupMenu = groupMenu();

    if (!capturedMenu && !capturedGroupMenu) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus());
    const close = () => closeMenu();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(true); };

    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    const scroll = sessionScrollRef.current; scroll?.addEventListener("scroll", close, { passive: true });

    return () => { cancelAnimationFrame(frame); window.removeEventListener("click", close); window.removeEventListener("keydown", closeOnEscape); window.removeEventListener("blur", close); scroll?.removeEventListener("scroll", close); };
  }, () => [menu(), groupMenu()]);
  createDependencyEffect(() => {
    const focusSearch = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };

    window.addEventListener("keydown", focusSearch);

    return () => window.removeEventListener("keydown", focusSearch);
  }, () => []);
  createDependencyEffect(() => { const capturedPanel = panel();

    if (!capturedPanel.createGroupRequest) return;
    setGroupProject(undefined); groupDraftActive.current = true; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName("");
    sessionScrollRef.current?.scrollTo({ top: 0 });
    capturedPanel.onCreateGroupHandled?.();
  }, () => [panel().createGroupRequest, panel().onCreateGroupHandled]);
  // A new chat closes the form for a new group that the Group button opened.
  createDependencyEffect(() => { if (panel().newChatRequest && untrack(newGroupName) !== undefined && !untrack(editingGroupId)) void finishGroup(true); }, () => [panel().newChatRequest]);
  createDependencyEffect(() => { const capturedNewGroupName = newGroupName();

    if (capturedNewGroupName === undefined) return;
    const frame = requestAnimationFrame(() => groupNameRef.current?.focus());

    return () => cancelAnimationFrame(frame);
  }, () => [newGroupName() === undefined, editingGroupId()]);
  createDependencyEffect(() => () => { removeMouseListenersRef.current();

    if (autoScrollFrameRef.current !== undefined) cancelAnimationFrame(autoScrollFrameRef.current); }, () => []);
  createDependencyEffect(() => {
    const capturedMenu = menu(); const capturedPanel = panel();

    if (capturedMenu && !capturedPanel.sessions.some((session) => sessionKey(session) === sessionKey((capturedMenu).session))) closeMenu(); }, () => [menu(), panel().sessions]);

  const finishGroup = async (cancel = false) => { const capturedNewGroupName = newGroupName(); const capturedEditingGroupId = editingGroupId();

    if (!groupDraftActive.current || groupSavePending.current) return;
    const name = (capturedNewGroupName ?? "").trim();

    if (cancel) { groupDraftActive.current = false; setEditingGroupId(undefined); setGroupDraftError(undefined); setNewGroupName(undefined);

      return; }

    const error = validateGroupName(name, capturedEditingGroupId);

    if (error) { setGroupDraftError(error);

      return; }

    if (!storedGroups.state) { setGroupDraftError("Groups are still loading.");

      return; }

    groupSavePending.current = true; setGroupSaving(true);

    try {
      await saveGroup(name, capturedEditingGroupId, groupProject());
      groupDraftActive.current = false; setGroupDraftError(undefined); setNewGroupName(undefined); setEditingGroupId(undefined);
    } catch (reason) { setGroupDraftError((reason instanceof Error ? reason.message : String(reason))); }
    finally { groupSavePending.current = false; setGroupSaving(false); }
  };

  const createProjectGroup = (project: GroupProject) => {
    setGroupProject(project);
    setNewGroupName(project.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || project.cwd || "Project");
    void finishGroup();
  };

  const editGroup = (group: CustomGroup) => { groupDraftActive.current = true; setEditingGroupId(group.id); setGroupDraftError(undefined); setNewGroupName(group.name); requestAnimationFrame(() => groupNameRef.current?.select()); };

  const selectedProjectKey = () => {
    const activeSession = panel().sessions.find((session) => session.id === panel().activeId && (session.hostId ?? "local") === panel().activeHostId);

    return activeSession ? visualProjectKey(activeSession) : undefined;
  };

  const activeProjectKey = createMemo(() => (selectedProjectKey()));

  const moveSessionByKeyboard = (drag: DraggedSession, direction: -1 | 1, betweenGroups: boolean) => {
    const sourceSessions = groupedSessionsRef.current.get(drag.projectKey) ?? [];
    const focused = document.activeElement;

    const restoreFocus = () => requestAnimationFrame(() => {
      if (document.activeElement !== document.body && document.activeElement !== focused) return;
      sessionScrollRef.current?.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(drag.sessionKey)}"] .session-main`)?.focus({ preventScroll: true });
    });

    if (betweenGroups) {
      const destinationKeys = keyboardSidebarEntries().filter((token) => token.startsWith("group:")).map((token) => token.slice("group:".length));
      const sourceIndex = destinationKeys.indexOf(drag.projectKey); const destinationKey = destinationKeys[sourceIndex + direction];

      if (!destinationKey || destinationKey === DIRLESS_KEY) return;
      void moveSession(drag, destinationKey)?.then(restoreFocus); expandProject(destinationKey);

      return;
    }

    const sourceIndex = sourceSessions.findIndex((session) => sessionKey(session) === drag.sessionKey); const target = sourceSessions[sourceIndex + direction];

    if (!target) return;
    void moveSession(drag, drag.projectKey, sessionKey(target), direction < 0 ? "before" : "after")?.then(restoreFocus);
  };

  const startMouseDrag = (event: MouseEvent<HTMLElement>, drag: DraggedItem) => {
    if (event.button === 0) startDrag(event.clientX, event.clientY, drag, "mouse");
  };

  const startTouchDrag = (event: TouchEvent, drag: DraggedItem, onHoldRelease?: (x: number, y: number) => void) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;

    if (touch) startDrag(touch.clientX, touch.clientY, drag, "touch", onHoldRelease);
  };

  const startDrag = (startX: number, startY: number, drag: DraggedItem, input: "mouse" | "touch", onHoldRelease?: (x: number, y: number) => void) => {
    if (!("sessionKey" in drag) && isFixedGroup(drag.projectKey)) return;

    if (normalizedQuery()) return;
    removeMouseListenersRef.current();
    const mouseDrag: MouseDrag = { ...drag, startX, startY, active: false };
    mouseDragRef.current = mouseDrag;
    let holdTimer: number | undefined;
    let touchMoved = false;

    const clear = () => {
      removeMouseListenersRef.current();
      window.clearTimeout(holdTimer);
      touchHoldRef.current = false;
      mouseDragRef.current = undefined;
      mouseDropTargetRef.current = undefined;
      setDraggedSession(undefined);
      setDraggedProject(undefined);
      setDropTarget(undefined);
      dragPointerRef.current = undefined;

      if (autoScrollFrameRef.current !== undefined) { cancelAnimationFrame(autoScrollFrameRef.current); autoScrollFrameRef.current = undefined; }
    };

    const customDropDestination = (hit: Element | null) => {
      const destination = hit?.closest<HTMLElement>("[data-drop-project-key]")?.dataset.dropProjectKey;

      return destination && customGroupsByKey().has(destination) ? destination : undefined;
    };

    const entryDropLocation = (parentKey: string | undefined, token: string, edge: "before" | "after") => {
      const entries = parentKey ? groupEntries(parentKey) : siblingEntries();
      const index = entries.indexOf(token);

      return edge === "before" ? token : entries[index + 1] ?? null;
    };

    const entryParent = (element: HTMLElement, token: string) => token.startsWith("session:") ? element.dataset.projectKey : projectParent(token.slice("group:".length));

    const projectDropTarget = (hit: Element | null, y: number, projectKey: string): DropTarget | undefined => {
      const destination = customDropDestination(hit);

      if (destination) return canMoveProject(projectKey, destination) ? { projectKey: destination, sessionKey: "", edge: "after", parentKey: destination } : undefined;

      const entryElement = hit?.closest<HTMLElement>("section[data-sidebar-token], .session-item[data-sidebar-token]");
      const token = entryElement?.dataset.sidebarToken;

      if (!entryElement || !token || token === groupLayoutToken(projectKey)) return;
      const bounds = entryElement.getBoundingClientRect();
      const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
      const parentKey = entryParent(entryElement, token);

      if (!canMoveProject(projectKey, parentKey)) return;

      return { projectKey: RECENT_KEY, sessionKey: "", edge, parentKey, layoutBefore: entryDropLocation(parentKey, token, edge) };
    };

    const emptyProjectDrop = (hit: Element | null): DropTarget | undefined => {
      const projectElement = hit?.closest<HTMLElement>("[data-drop-project-key]");

      return projectElement ? { projectKey: required(projectElement.dataset.dropProjectKey), sessionKey: "", edge: "after" } : undefined;
    };

    const sidebarZoneTarget = (zone: HTMLElement, current: MouseDrag): DropTarget | undefined => {
      const parentKey = zone.dataset.sidebarParent;

      if (!("session" in current) && !canMoveProject(current.projectKey, parentKey)) return;

      return { projectKey: parentKey ?? RECENT_KEY, sessionKey: "", edge: "after", parentKey, layoutBefore: zone.dataset.sidebarEnd === "true" ? null : required(zone.dataset.sidebarBefore) };
    };

    const updateDropTarget = (x: number, y: number, current: MouseDrag) => {
      const hit = document.elementFromPoint(x, y);
      let nextTarget: DropTarget | undefined;
      const sidebarDropZone = hit?.closest<HTMLElement>("[data-sidebar-drop-zone]");
      const sessionElement = hit?.closest<HTMLElement>(".session-item[data-session-key]");

      if (sidebarDropZone) {
        nextTarget = sidebarZoneTarget(sidebarDropZone, current);
      } else if (!("session" in current)) {
        nextTarget = projectDropTarget(hit, y, current.projectKey);
      } else if (sessionElement && sessionElement.dataset.sessionKey !== current.sessionKey) {
        const bounds = sessionElement.getBoundingClientRect();
        const edge = y < bounds.top + bounds.height / 2 ? "before" : "after";
        const projectKey = required(sessionElement.dataset.projectKey); const targetKey = required(sessionElement.dataset.sessionKey);
        nextTarget = { projectKey, sessionKey: targetKey, edge };
      } else if (!sessionElement) {
        nextTarget = emptyProjectDrop(hit);
      }

      if (isBlockedDirlessTarget(current, nextTarget)) nextTarget = undefined;

      mouseDropTargetRef.current = nextTarget;
      setDropTarget(nextTarget);
    };

    const autoScroll = () => {
      autoScrollFrameRef.current = undefined;
      const pointer = dragPointerRef.current; const scroll = sessionScrollRef.current; const current = mouseDragRef.current;

      if (!pointer || !scroll || !current?.active) return;
      const bounds = scroll.getBoundingClientRect(); const edgeSize = 42;
      const speed = pointer.y < bounds.top + edgeSize ? -Math.ceil((bounds.top + edgeSize - pointer.y) / 4) : pointer.y > bounds.bottom - edgeSize ? Math.ceil((pointer.y - (bounds.bottom - edgeSize)) / 4) : 0;

      if (speed) { scroll.scrollTop += speed; updateDropTarget(pointer.x, pointer.y, current); autoScrollFrameRef.current = requestAnimationFrame(autoScroll); }
    };

    const activate = (current: MouseDrag) => {
      current.active = true;

      if ("session" in current) setDraggedSession(current); else setDraggedProject(current.projectKey);
    };

    const moveTo = (x: number, y: number, event: Event) => {
      const current = mouseDragRef.current;

      if (!current) return;

      if (!current.active && Math.hypot(x - current.startX, y - current.startY) < 5) return;

      if (!current.active) activate(current);

      event.preventDefault(); dragPointerRef.current = { x, y };
      updateDropTarget(x, y, current);

      if (autoScrollFrameRef.current === undefined) autoScrollFrameRef.current = requestAnimationFrame(autoScroll);
    };

    const move = (event: globalThis.MouseEvent) => moveTo(event.clientX, event.clientY, event);

    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0];

      if (!touch) return;

      if (!mouseDrag.active) {
        if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > TOUCH_SCROLL_SLOP) clear();

        return;
      }

      touchMoved = true;
      moveTo(touch.clientX, touch.clientY, event);
    };

    const placeDroppedProject = (current: MouseDrag, target: DropTarget, token: string) => {
      if (!canMoveProject(current.projectKey, target.parentKey)) return;
      moveProject(current.projectKey, target.parentKey);

      if (target.layoutBefore === undefined) return;

      if (target.parentKey) placeGroupEntry(target.parentKey, token, target.layoutBefore);
      else placeSidebarEntry(token, target.layoutBefore);
    };

    const finish = () => {
      const current = mouseDragRef.current;

      if (!current) return;

      if (current.active) {
        const sourceToken = "session" in current ? sessionLayoutToken(current.sessionKey) : groupLayoutToken(current.projectKey);
        suppressClickRef.current = sourceToken;
        window.setTimeout(() => { if (suppressClickRef.current === sourceToken) suppressClickRef.current = undefined; }, 0);
        const target = mouseDropTargetRef.current;

        if (target) {
          if ("session" in current) {
            moveSession(current, target.projectKey, target.sessionKey || undefined, target.edge);

            if (target.layoutBefore !== undefined && target.parentKey) placeGroupEntry(target.parentKey, sourceToken, target.layoutBefore);
            expandProject(target.projectKey);
          } else placeDroppedProject(current, target, sourceToken);
        }
      }

      clear();
    };

    const cancel = () => clear();

    const touchEnd = (event: TouchEvent) => {
      if (!mouseDrag.active) { clear();

        return; }

      event.preventDefault();

      if (!touchMoved && onHoldRelease) { onHoldRelease(startX, startY); clear();

        return; }

      finish();
    };

    window.addEventListener("blur", cancel);

    if (input === "touch") {
      touchHoldRef.current = true;
      holdTimer = window.setTimeout(() => { if (mouseDragRef.current === mouseDrag) activate(mouseDrag); }, TOUCH_HOLD_MS);
      window.addEventListener("touchmove", touchMove, { passive: false });
      window.addEventListener("touchend", touchEnd, { passive: false });
      window.addEventListener("touchcancel", cancel);
    } else {
      window.addEventListener("mousemove", move, { passive: false });
      window.addEventListener("mouseup", finish);
    }

    removeMouseListenersRef.current = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", cancel);
      window.removeEventListener("blur", cancel);
      removeMouseListenersRef.current = () => { };
    };
  };

  const canReorderProject = (event: KeyboardEvent<HTMLElement>) => !normalizedQuery() && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown");

  const projectDragProps = (projectKey: string) => ({
    onMouseDown: (event: MouseEvent<HTMLElement>) => startMouseDrag(event, { projectKey }),
    onTouchStart: (event: TouchEvent) => startTouchDrag(event, { projectKey }),
    onContextMenu: (event: globalThis.MouseEvent) => { if (touchHoldRef.current) event.preventDefault(); },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (suppressClickRef.current === groupLayoutToken(projectKey)) { suppressClickRef.current = undefined; event.preventDefault();

        return; }

      toggleProject(projectKey);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!canReorderProject(event)) return;
      event.preventDefault();
      const parent = projectParent(projectKey);
      const entries = parent ? groupEntries(parent) : siblingEntries(); const token = groupLayoutToken(projectKey); const index = entries.indexOf(token);
      const direction = event.key === "ArrowUp" ? -1 : 1;

      if (index + direction < 0 || index + direction >= entries.length) return;
      const before = direction < 0 ? entries[index - 1] : entries[index + 2] ?? null;

      if (parent) placeGroupEntry(parent, token, before);
      else placeSidebarEntry(token, before);
    },
    "aria-description": isFixedGroup(projectKey) ? "Always shown below project groups." : !normalizedQuery() ? "Drag to reorder or move into a group. Custom groups can nest up to three levels. Press Alt plus Up or Down to reorder." : undefined,
    "aria-keyshortcuts": !isFixedGroup(projectKey) && !normalizedQuery() ? "Alt+ArrowUp Alt+ArrowDown" : undefined,
  });

  const isActiveSession = (session: SessionSummary) => panel().activeId === session.id && (session.hostId ?? "local") === panel().activeHostId;
  const isSavedSession = (session: SessionSummary) => !session.isDraft && Boolean(session.path);


  const SessionRow = (row: { session: SessionSummary; projectKey: string }) => {
    const session = () => row.session;
    const projectKey = row.projectKey;
    const key = createMemo(() => sessionKey(session()));
    const running = createMemo(() => session().isRunning || panel().runningSessions.has(key()));
    const activity = createMemo(() => panel().unseenSessions.has(key()) ? "New activity" : undefined);
    const archiving = () => props.isArchiving(session());

    const archive = () => {
      if (!archiving()) void panel().onAction(session(), "archive");
    };

    const accessibleActivity = () => running() ? "Running" : activity();
    const target = createMemo(() => dropTarget()?.projectKey === projectKey && dropTarget()?.sessionKey === key() ? dropTarget()?.edge : undefined);
    const drag = () => ({ projectKey, sessionKey: key(), session: session() });

    const openSessionMenu = (x: number, y: number, returnFocus?: HTMLElement) => {
      if (archiving()) return;
      setGroupMenu(undefined); setMenu({ session: session(), x: Math.min(x, window.innerWidth - 190), y: Math.min(y, window.innerHeight - 190), returnFocus });
    };

    const renderSessionMain = () => (<button class="session-main" disabled={archiving()} aria-label={`${session().name}, ${directoryLabel(session())}, ${formatApiCost(session().apiCost)}${accessibleActivity() ? `, ${accessibleActivity()}` : ""}`} aria-current={isActiveSession(session()) ? "page" : undefined} aria-description={!normalizedQuery() ? "Press Alt plus Up or Down to reorder. Add Shift to move between groups." : undefined} aria-keyshortcuts={!normalizedQuery() ? "Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown" : undefined} onMouseDown={(event) => { if (!archiving()) startMouseDrag(event, drag()); }} onTouchStart={(event) => { const element = event.currentTarget; if (!archiving()) startTouchDrag(event, drag(), (x, y) => openSessionMenu(x, y, element)); }} onKeyDown={(event) => { if (!archiving() && !normalizedQuery() && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); moveSessionByKeyboard(drag(), event.key === "ArrowUp" ? -1 : 1, event.shiftKey); } }} onClick={(event) => { if (archiving()) return;

      if (suppressClickRef.current === sessionLayoutToken(key())) { suppressClickRef.current = undefined; event.preventDefault();

        return; }

      panel().onSelect(session()); }}><span class="session-copy"><span class="session-title-row"><Show when={pickedProject(session())}><Folder class="session-leading-icon" size={14} aria-hidden="true" /></Show><strong>{session().name}</strong><span class="session-api-cost" data-tooltip="Would-be API cost">{formatApiCost(session().apiCost)}</span></span></span></button>);

    const renderArchiveButton = () => (<button class="session-archive" aria-busy={archiving()} aria-label={`${archiving() ? "Archiving" : "Archive"} ${session().name}`} data-tooltip={!isSavedSession(session()) ? "Send a message before archiving this draft" : `${archiving() ? "Archiving" : "Archive"} ${session().name}`} disabled={archiving() || !isSavedSession(session())} onClick={() => void archive()}><Show when={archiving()} fallback={<Archive size={14} />}><LoaderCircle size={14} class="spinning" /></Show></button>);


    return <div data-sidebar-token={sessionLayoutToken(key())} data-session-key={key()} data-project-key={projectKey} class={`session-item ${!normalizedQuery() ? "reorderable" : ""} ${isActiveSession(session()) ? "active" : ""} ${running() ? "running" : activity() ? "unseen" : ""} ${draggedSession()?.sessionKey === key() ? "dragging" : ""} ${target() ? `drop-${target()}` : ""}`} onContextMenu={(event) => { event.preventDefault();

      if (touchHoldRef.current) return; openSessionMenu(event.clientX, event.clientY, document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget.querySelector<HTMLElement>(".session-main") ?? undefined); }}>
      {renderSessionMain()}
      {renderArchiveButton()}
    </div>;
  };

  const groupsByToken = createMemo(() => (new Map(groups().map((group): [string, typeof group] => [groupLayoutToken(group[0]), group]))));

  const contextMenu = () => {
    const activeMenu = groupMenu() ?? menu();
    const groupDirectory = groupMenu() ? groupDestination(required(groupMenu()).projectKey) : undefined;
    const customGroup = groupMenu() ? customGroupsByKey().get(required(groupMenu()).projectKey) : undefined;

    const menuItems = groupMenu() ? [
      ...(customGroup ? [{ label: "Rename group", Icon: Pencil, disabled: false, run: () => { closeMenu(); editGroup(customGroup); } }] : []),
      ...(groupDirectory?.cwd ? [{ label: "Open directory", Icon: FolderOpen, disabled: false, run: () => { setGroupActionError(undefined); void openGroupDirectory(required(groupDirectory.cwd), groupDirectory.hostId ?? "local").catch((reason) => setGroupActionError((reason instanceof Error ? reason.message : String(reason)))); } }] : []),
      { label: "Forget group", Icon: Trash2, disabled: false, run: () => setRemovingGroup({ id: required((groupMenu())).projectKey, name: required((groupMenu())).label }) },
    ] : menu() ? actions.flatMap(([action, Icon, label]) => (!isMobile || action !== "new-window") && (!["copy-id", "open-rollout"].includes(action) || panel().debug) ? [{ label, Icon, disabled: props.isArchiving(required(menu()).session) || (required(menu()).session.isDraft === true && action !== "open-directory") || (action === "open-rollout" && !required(menu()).session.path), run: () => panel().onAction(required((menu())).session, action) }] : []) : [];

    return { activeMenu, menuItems };
  };

  const menuActions = createMemo(() => (contextMenu()));
  const isEditingGroup = (projectKey: string) => customGroupsByKey().has(projectKey) && editingGroupId() === customGroupsByKey().get(projectKey)?.id;
  const renderDropZone = (beforeToken: string | null, parentKey?: string) => (<div data-sidebar-drop-zone data-sidebar-parent={parentKey} data-sidebar-before={beforeToken ?? undefined} data-sidebar-end={beforeToken === null ? true : undefined} class={`sidebar-drop-zone ${dropTarget()?.layoutBefore === beforeToken && dropTarget()?.parentKey === parentKey ? "active" : ""}`} />);

  const renderSessionScroll = () => {
    const renderGroupError = () => ((storedGroups.error || groupActionError()) && <p class="group-error" role="alert">{storedGroups.error || groupActionError()}</p>);
    const renderGroupLoading = () => (!storedGroups.state && !storedGroups.error && <p class="empty-small">Loading groups…</p>);
    const renderNewGroup = () => (<Show when={newGroupName() !== undefined && !editingGroupId()}><section class="project custom-group-draft"><div class="project-label"><input ref={element => { groupNameRef.current = element; }} disabled={groupSaving()} aria-label="Group name" aria-invalid={Boolean(groupDraftError())} aria-describedby={groupDraftError() ? "new-group-error" : undefined} placeholder="Group name" value={(newGroupName())} onInput={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} /></div><div class="group-draft-or">OR</div><GroupProjectPicker transport={props.transport} settings={props.settings} hostId={panel().activeHostId} disabled={groupSaving()} project={groupProject()} onCancel={() => void finishGroup(true)} onSelect={createProjectGroup} />{groupDraftError() && <small id="new-group-error" class="group-error">{(groupDraftError())}</small>}</section></Show>);
    const renderEmptyConversations = () => (storedGroups.state && !filtered().length && <div class="empty-small">{normalizedQuery() ? `No conversations match “${panel().query.trim()}”.` : "No conversations yet."}</div>);

    const renderGroups = (parentKey?: string, selectedTokens?: string[]): JSX.Element => <Key each={(selectedTokens ?? siblingEntries(parentKey)).filter((token) => groupsByToken().has(token))} by={(token) => token}>{(token) => {
        const group = () => required(groupsByToken().get(token())); const projectKey = group()[0]; const label = () => groupLabel(group()[1], group()[2], group()[3]); const collapsed = () => !normalizedQuery() && collapsedProjects().has(projectKey); const groupId = disclosureId(projectKey);

        const visibleSessions = createMemo<SessionSummary[]>((previous = []) => {
          if (!collapsed()) return group()[4];

          if (!previous.length) return previous;
          const retained = new Set(previous.map(sessionKey));

          return group()[4].filter(session => retained.has(sessionKey(session)));
        });

        const renderProjectHeading = () => {
          const disclosureLabel = () => `${collapsed() ? "Expand" : "Collapse"} ${label()}`;

          const renderProjectLabel = () => {
            const renderGroupNameInput = () => (<input ref={element => { groupNameRef.current = element; }} disabled={groupSaving()} aria-label="Rename session group" aria-invalid={Boolean(groupDraftError())} aria-describedby={groupDraftError() ? "rename-group-error" : undefined} value={newGroupName() ?? ""} onInput={(event) => { setNewGroupName(event.target.value); setGroupDraftError(undefined); }} onBlur={() => finishGroup()} onKeyDown={(event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); finishGroup(); } else if (event.key === "Escape") { event.preventDefault(); finishGroup(true); } }} />);

            return (isEditingGroup(projectKey) ? <div class="project-label">{renderGroupNameInput()}{groupDraftError() && <small id="rename-group-error" class="group-error">{(groupDraftError())}</small>}</div> : <>
              <button class="project-disclosure" aria-label={disclosureLabel()} aria-expanded={!collapsed()} aria-controls={groupId} onClick={() => toggleProject(projectKey)}><ChevronDown class={collapsed() ? "collapsed" : ""} size={13} /></button><button class="project-label" disabled={Boolean(normalizedQuery())} {...projectDragProps(projectKey)}>{projectDetails().get(projectKey)?.cwd && <Folder size={14} aria-hidden="true" />}<span class={projectKey === activeProjectKey() ? "active" : undefined}>{label()}</span></button>
              {!isFixedGroup(projectKey) && <div class="project-actions">
                <button aria-label={`New chat in ${label()}`} data-tooltip="New chat in group" onClick={() => {
                  const destination = groupDestination(projectKey);

                  if (!destination) return;
                  expandProject(projectKey);
                  panel().onNewChat(destination);
                }}><MessageSquarePlus size={14} /></button>
                <button aria-label={`Group actions for ${label()}`} data-tooltip="Group actions" aria-haspopup="menu" aria-expanded={groupMenu()?.projectKey === projectKey} onClick={(event) => {
                  event.stopPropagation();

                  if (groupMenu()?.projectKey === projectKey) { closeMenu(true);

                    return; }

                  const bounds = event.currentTarget.getBoundingClientRect();
                  setMenu(undefined);
                  setGroupMenu({ projectKey, label: label(), x: Math.max(8, Math.min(bounds.right - 188, window.innerWidth - 196)), y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 148)), returnFocus: event.currentTarget });
                }}><Ellipsis size={14} /></button>
              </div>}
            </>);
          };

          return (<div class="project-heading" data-drop-project-key={projectKey}>
            {renderProjectLabel()}
          </div>);
        };

        return [projectKey !== DIRLESS_KEY && renderDropZone(token(), parentKey), <section data-sidebar-token={token()} class={`project ${!normalizedQuery() ? "reorderable" : ""} ${draggedProject() === projectKey ? "dragging" : ""} ${projectKey !== DIRLESS_KEY && (draggedSession() || draggedProject()) && dropTarget()?.projectKey === projectKey && dropTarget()?.layoutBefore === undefined ? "drop-project" : ""}`} >
          {renderProjectHeading()}
          <div id={groupId} class={!isFixedGroup(projectKey) ? "project-children" : undefined} hidden={collapsed()}>
            <Show when={customGroupsByKey().has(projectKey)} fallback={<Key each={visibleSessions()} by={sessionKey}>{session => <SessionRow session={session()} projectKey={projectKey} />}</Key>}>
              <Key each={groupEntries(projectKey)} by={entry => entry}>{entry => {
                const session = () => visibleSessions().find(item => sessionLayoutToken(sessionKey(item)) === entry());

                return entry().startsWith("group:") ? renderGroups(projectKey, [entry()]) : <Show when={session()}>{item => <>{renderDropZone(entry(), projectKey)}<SessionRow session={item()} projectKey={projectKey} /></>}</Show>;
              }}</Key>
              {renderDropZone(null, projectKey)}
            </Show>
          </div>
        </section>];
      }}</Key>;

    return (<div ref={element => { sessionScrollRef.current = element; }} class="session-scroll">
      {renderGroupError()}
      {renderGroupLoading()}
      {renderNewGroup()}
      {renderGroups()}
      {sidebarEntries().length > 0 && renderDropZone(null)}
      {renderEmptyConversations()}
    </div>);
  };

  const renderConversationMenu = () => (menuActions().activeMenu && <div ref={element => { menuRef.current = element; }} class="conversation-menu session-context-menu" role="menu" aria-label={`${groupMenu()?.label ?? menu()?.session.name} actions`} style={{ left: cssPixels(required((menuActions().activeMenu)).x), top: cssPixels(required((menuActions().activeMenu)).y) }} onContextMenu={(event) => event.preventDefault()} onKeyDown={(event) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.findIndex(item => item === document.activeElement);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === "Home" || event.key === "End") { event.preventDefault(); items[event.key === "Home" ? 0 : items.length - 1]?.focus(); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
  }}>{<Key each={menuActions().menuItems} by={({ label }) => label}>{(entry, _index) => <button  role="menuitem" disabled={entry().disabled} data-tooltip={entry().disabled ? groupMenu() ? "Custom groups have no directory" : "Send a message before cloning this draft" : undefined} onClick={() => { const run = entry().run; run(); closeMenu(true); }}><Dynamic component={entry().Icon} size={14} />{entry().label}</button>}</Key>}</div>);

  return <aside class="session-panel">
    {removingGroup() && <RemoveGroupDialog name={required((removingGroup())).name} onCancel={() => setRemovingGroup(undefined)} onRemove={async () => {
      const capturedRemovingGroup = removingGroup();

      await removeGroup(required((capturedRemovingGroup)).id); setRemovingGroup(undefined); }} />}
    <label class="search"><Search size={15} /><input ref={element => { searchRef.current = element; }} aria-label="Search conversations" placeholder="Search conversations" value={panel().query} onInput={(event) => panel().onQuery(event.target.value)} /><kbd>Ctrl G</kbd></label>
    {renderSessionScroll()}
    {renderConversationMenu()}
  </aside>;
}
