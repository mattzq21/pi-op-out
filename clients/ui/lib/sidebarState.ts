import { createMemo,type Accessor } from "solid-js";
import type { SessionSummary } from "../types";
import { hasVisibleText } from "./content";
import { DIRLESS_KEY,isTemporaryChatCwd,useSessionGroups, type OrderChange, type SessionGroup } from "./sessionGroups";
import { useSessionProjects } from "./sessionProjects";
import { createDependencyEffect } from "./solid";
import { createSidebarPersistence } from "./sidebarPersistence";

export interface DraggedSession { projectKey: string; sessionKey: string; session: SessionSummary; }

type SidebarGroup = readonly [key: string, name: string, hostId: string, hostName: string | undefined, sessions: SessionSummary[]];

export const RECENT_KEY = "__pi-desktop-ungrouped__";

const RECENT_LABEL = "Recents";

export const isFixedGroup = (key: string) => key === RECENT_KEY || key === DIRLESS_KEY;

const sidebarCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function stableSessionOrder(left: SessionSummary, right: SessionSummary) {
  return sidebarCollator.compare(left.name, right.name) || sidebarCollator.compare(left.id, right.id);
}

function recentSessionOrder(left: SessionSummary, right: SessionSummary) {
  return right.lastMessageAt - left.lastMessageAt || stableSessionOrder(left, right);
}

function addedSessionOrder(left: SessionSummary, right: SessionSummary) {
  return left.lastMessageAt - right.lastMessageAt || stableSessionOrder(left, right);
}

export function sessionKey(session: SessionSummary) { return `${session.hostId ?? "local"}:${session.id}`; }

function projectName(session: SessionSummary) { return session.project; }

export function sessionLayoutToken(key: string) { return `session:${key}`; }

export function groupLayoutToken(key: string) { return `group:${key}`; }

function orderedSessions(projectKey: string, sessions: SessionSummary[], orders: Record<string, string[]>) {
  const customOrder = orders[projectKey];
  const defaultOrder = projectKey === RECENT_KEY ? recentSessionOrder : stableSessionOrder;

  if (!customOrder) return [...sessions].sort(defaultOrder);
  const positions = new Map(customOrder.map((key, index) => [key, index]));
  const unsavedOrder = isFixedGroup(projectKey) ? defaultOrder : addedSessionOrder;

  return [...sessions].sort((left, right) => {
    const leftPosition = positions.get(sessionKey(left)); const rightPosition = positions.get(sessionKey(right));

    if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;

    if (leftPosition !== undefined) return projectKey === RECENT_KEY ? 1 : -1;

    if (rightPosition !== undefined) return projectKey === RECENT_KEY ? -1 : 1;

    return unsavedOrder(left, right);
  });
}

export type SidebarState = ReturnType<typeof createSidebarState>;

export function createSidebarState(source: Accessor<SessionSummary[]>, query: Accessor<string>, projects?: ReturnType<typeof useSessionGroups>) {
  const sessions = createMemo(() => {
    return source().filter(session => !session.auxiliaryParentId);
  });

  const storedGroups = projects ?? useSessionProjects();
  const savedGroups = createMemo(() => storedGroups.state?.groups ?? []);
  const savedGroupsById = createMemo(() => new Map(savedGroups().map((group): [string, SessionGroup] => [group.id, group]).reverse()));
  const customGroups = createMemo(() => savedGroups().filter(group => !group.cwd && group.id !== DIRLESS_KEY));
  const parentGroupsByKey = createMemo(() => new Map(savedGroups().filter(group => group.id !== DIRLESS_KEY && !(group.cwd && isTemporaryChatCwd(group.cwd))).map((group): [string, SessionGroup] => [group.id, group])));
  const persistence = createSidebarPersistence();
  const collapsedProjects = createMemo(() => new Set(persistence.layout().collapsed));
  const sessionOrders = createMemo(() => storedGroups.state?.orders.sessions ?? {});
  const sidebarOrder = () => storedGroups.state?.orders.sidebar ?? [];
  const projectGroups = () => storedGroups.state?.parents ?? {};
  const groupChildOrders = () => storedGroups.state?.orders.children ?? {};
  const setCollapsedProjects = (update: (current: Set<string>) => Set<string>) => persistence.change("collapsed", current => [...update(new Set(current))]);
  const placeOrderToken = (scope: OrderChange["scope"], owner: string, visible: string[], token: string | null, before: string | null) => storedGroups.change({ type: "order", scope, owner, visible, token, before });

  const projectParent = (id: string) => {
    const parent = projectGroups()[id];

    return !isFixedGroup(id) && savedGroupsById().has(id) && parent !== undefined && parentGroupsByKey().has(parent) ? parent : undefined;
  };

  const groupAncestors = (id: string) => {
    const ancestors: string[] = [];
    const seen = new Set([id]);
    let parent = projectParent(id);

    while (parent && !seen.has(parent)) {
      ancestors.push(parent);
      seen.add(parent);
      parent = projectParent(parent);
    }

    return ancestors;
  };

  const canMoveProject = (id: string, parent?: string) => {
    if (isFixedGroup(id) || !savedGroupsById().has(id)) return false;

    if (parent === undefined) return true;

    if (!parentGroupsByKey().has(parent) || parent === id) return false;
    const ancestors = [parent, ...groupAncestors(parent)];

    if (ancestors.includes(id)) return false;
    const isProject = (key: string) => Boolean(savedGroupsById().get(key)?.cwd);
    const children = (key: string) => savedGroups().filter(group => projectParent(group.id) === key).map(group => group.id);
    const subtreeHeight = (key: string): number => (isProject(key) ? 0 : 1) + Math.max(0, ...children(key).map(subtreeHeight));
    const subtreeProjects = (key: string): number => (isProject(key) ? 1 : 0) + Math.max(0, ...children(key).map(subtreeProjects));
    const projects = ancestors.filter(isProject).length;

    return ancestors.length - projects + subtreeHeight(id) <= 3 && projects + subtreeProjects(id) <= 1;
  };

  const moveProject = (id: string, parent?: string) => {
    if (!canMoveProject(id, parent)) return;
    void storedGroups.change({ type: "move", id, parent: parent ?? null }).then(() => {
      if (parent) expandProject(parent);
    }).catch(() => undefined);
  };

  const groupNameTaken = (name: string, excludedId?: string) => name.trim().toLowerCase() === "dirless" || sidebarCollator.compare(RECENT_LABEL, name.trim()) === 0 || storedGroups.state?.groups.some((group) => group.id !== excludedId && sidebarCollator.compare(group.name.trim(), name.trim()) === 0);

  const validateGroupName = (name: string, excludedId?: string) => {
    if (!name || !hasVisibleText(name)) return "Enter a group name.";

    if (name.length > 80) return "Keep the group name under 80 characters.";

    if (groupNameTaken(name, excludedId)) return "A project or group already uses that name.";
  };

  const removeGroup = async (projectKey: string) => {
    await storedGroups.change({ type: "remove", id: projectKey });
    persistence.removeGroup(projectKey);
  };

  const toggleProject = (projectKey: string) => setCollapsedProjects((current) => {
    const next = new Set(current);

    if (next.has(projectKey)) next.delete(projectKey); else next.add(projectKey);

    return next;
  });

  const expandProject = (projectKey: string) => {
    setCollapsedProjects((current) => {
      const keys = [projectKey, ...groupAncestors(projectKey)];

      if (!keys.some(key => current.has(key))) return current;
      const next = new Set(current);
      keys.forEach(key => next.delete(key));

      return next;
    });
  };

  const placeSessionEntry = (destinationKey: string, key: string, targetKey: string | undefined, edge: "before" | "after") => {
    const target = targetKey ? sessionLayoutToken(targetKey) : undefined;
    const entries = groupEntries(destinationKey).filter(token => token !== sessionLayoutToken(key));
    const index = target ? entries.indexOf(target) : -1;
    const before = index < 0 ? null : edge === "before" ? target ?? null : entries[index + 1] ?? null;

    return placeGroupEntry(destinationKey, sessionLayoutToken(key), before);
  };

  const moveSession = (drag: DraggedSession, destinationKey: string, targetKey?: string, edge: "before" | "after" = "after") => {
    if (destinationKey === DIRLESS_KEY && drag.projectKey !== DIRLESS_KEY) return;
    const destinationSessions = displayedSessions().get(destinationKey);

    if (!destinationSessions) return;

    if (drag.projectKey === destinationKey && drag.sessionKey === targetKey) return;
    const visible = destinationSessions.map(sessionKey).filter(key => key !== drag.sessionKey);
    const targetIndex = targetKey ? visible.indexOf(targetKey) : -1;
    const before = targetIndex < 0 ? null : edge === "before" ? targetKey ?? null : visible[targetIndex + 1] ?? null;
    const changes = [placeOrderToken("sessions", destinationKey, visible, drag.sessionKey, before)];

    if (parentGroupsByKey().has(destinationKey)) changes.push(placeSessionEntry(destinationKey, drag.sessionKey, targetKey, edge));

    if (destinationKey !== DIRLESS_KEY) changes.push(storedGroups.change({ type: "assign", key: drag.sessionKey, group: destinationKey === RECENT_KEY ? null : destinationKey }));

    return Promise.all(changes).then(() => undefined, () => undefined);
  };

  const placeSidebarEntry = (token: string, beforeToken: string | null) => {
    if ([RECENT_KEY, DIRLESS_KEY].some(key => token === groupLayoutToken(key))) return;

    if (beforeToken === token) return;
    void placeOrderToken("sidebar", "", sidebarEntries(), token, beforeToken ?? groupLayoutToken(RECENT_KEY)).catch(() => undefined);
  };

  const groupDestination = (id: string) => savedGroupsById().get(id);
  const groupProject = (id: string) => [id, ...groupAncestors(id)].map(key => savedGroupsById().get(key)).find(group => group?.cwd);

  const normalizedQuery = createMemo(() => (query().trim().toLowerCase()));
  const customGroupsByKey = createMemo(() => (new Map(customGroups().map((group) => [group.id, group]))));

  const draftProjectGroup = (session: SessionSummary) => session.isDraft && session.cwd ? savedGroups().find(group => group.cwd === session.cwd && (group.hostId ?? "local") === (session.hostId ?? "local"))?.id : undefined;

  const visualProjectKey = (session: SessionSummary) => {
    if (session.cwdExists === false) return DIRLESS_KEY;
    const assignments = storedGroups.state?.assignments;
    const key = sessionKey(session);
    const destination = assignments && Object.hasOwn(assignments, key) ? assignments[key] : session.groupId ?? draftProjectGroup(session);

    if (!destination || destination === DIRLESS_KEY) return RECENT_KEY;
    const group = savedGroupsById().get(destination);

    return group?.cwd && isTemporaryChatCwd(group.cwd) ? RECENT_KEY : destination;
  };

  const filtered = createMemo(() => (sessions().filter((session) => {
    if (!storedGroups.state) return false;

    if (!normalizedQuery()) return true;
    const location = visualProjectKey(session);
    const groupName = location === DIRLESS_KEY ? "Dirless" : location === RECENT_KEY ? RECENT_LABEL : savedGroupsById().get(location)?.name ?? "";

    const parentName = groupAncestors(location).map(id => savedGroupsById().get(id)?.name ?? "").join(" ");

    return `${session.name} ${session.project} ${projectName(session)} ${session.preview} ${session.hostName ?? session.hostId ?? "Local"} ${groupName} ${parentName}`.toLowerCase().includes(normalizedQuery());
  })));

  const groupedSessions = createMemo(() => (filtered().reduce<Record<string, SessionSummary[]>>((result, session) => {
    (result[visualProjectKey(session)] ??= []).push(session);

    return result;
  }, {})));

  const recentSessions = createMemo(() => (orderedSessions(RECENT_KEY, groupedSessions()[RECENT_KEY] ?? [], sessionOrders())));
  const recentKeys = createMemo(() => (recentSessions().map(sessionKey).join("\n")));
  createDependencyEffect(() => {
    const saved = sessionOrders()[RECENT_KEY];

    if (normalizedQuery() || !saved) return;
    const known = new Set(saved);
    const visible = recentKeys().split("\n").filter(Boolean);

    if (visible.every(key => known.has(key))) return;
    void placeOrderToken("sessions", RECENT_KEY, visible, null, null).catch(() => undefined);
  }, () => [recentKeys(), normalizedQuery()]);
  const physicalGroups = createMemo(() => (savedGroups().filter((group) => group.cwd && !isTemporaryChatCwd(group.cwd)).map((group): SidebarGroup => [group.id, group.name, group.hostId ?? "local", group.hostName ?? undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())])));
  const customVisualGroups = createMemo(() => (customGroups().map((group): SidebarGroup => [group.id, group.name, "", undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())])));

  const groups = createMemo<SidebarGroup[]>(() => ([
    ...customVisualGroups().filter(([key, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0 || [...customVisualGroups(), ...physicalGroups()].some(([id, , , , children]) => children.length > 0 && groupAncestors(id).includes(key))),
    ...physicalGroups().filter(([key, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0 || [...customVisualGroups(), ...physicalGroups()].some(([id, , , , children]) => children.length > 0 && groupAncestors(id).includes(key))),
    [RECENT_KEY, RECENT_LABEL, "", undefined, recentSessions()],
    ...(groupedSessions()[DIRLESS_KEY]?.length ? [[DIRLESS_KEY, "Dirless", "", undefined, orderedSessions(DIRLESS_KEY, groupedSessions()[DIRLESS_KEY] ?? [], sessionOrders())] satisfies SidebarGroup] : []),
  ]));

  const displayedSessions = createMemo(() => new Map([[RECENT_KEY, recentSessions()], ...groups().map(([key, , , , projectSessions]): [string, SessionSummary[]] => [key, projectSessions])]));
  const defaultSidebarEntries = createMemo(() => (groups().map(([key]) => groupLayoutToken(key))));
  const fixedTokens = [groupLayoutToken(RECENT_KEY), groupLayoutToken(DIRLESS_KEY)];

  const orderedSidebarEntries = (entries: string[]) => {
    const availableEntries = new Set(entries);
    const order = sidebarOrder();
    const knownEntries = new Set(order);
    const addedEntries = entries.filter((entry) => !knownEntries.has(entry));

    return [...addedEntries.filter((entry) => !fixedTokens.includes(entry)), ...order.filter((entry) => !fixedTokens.includes(entry) && availableEntries.has(entry)), ...fixedTokens.filter(entry => availableEntries.has(entry))];
  };

  const sidebarEntries = createMemo(() => (orderedSidebarEntries(defaultSidebarEntries())));

  const groupEntries = (id: string) => {
    const entries = [
      ...(displayedSessions().get(id) ?? []).map(session => sessionLayoutToken(sessionKey(session))),
      ...sidebarEntries().filter(token => projectParent(token.slice("group:".length)) === id),
    ];

    const order = groupChildOrders()[id] ?? [];
    const available = new Set(entries);
    const known = new Set(order);

    return [...order.filter(token => available.has(token)), ...entries.filter(token => !known.has(token))];
  };

  const placeGroupEntry = (id: string, token: string, before: string | null) => {
    if (token === before) return Promise.resolve();

    return placeOrderToken("children", id, groupEntries(id), token, before).catch(() => undefined);
  };

  const saveGroup = (name: string, id?: string, project?: Pick<SessionGroup, "cwd" | "hostId" | "hostName">) => {
    if (id) return storedGroups.change({ type: "rename", id, name });

    if (project?.cwd) return storedGroups.change({ type: "project", project: { ...project, id: `__pi-desktop-custom-group__:${crypto.randomUUID()}`, name } });

    return storedGroups.change({ type: "create", name });
  };

  const editProject = (id: string, name: string, cwd: string) => storedGroups.change({ type: "edit", id, name, cwd });

  return {
    get state() { return storedGroups.state; }, get error() { return storedGroups.error ?? persistence.error(); },
    sessions, collapsedProjects, customGroupsByKey, parentGroupsByKey, groupDestination, groupProject,
    normalizedQuery, visualProjectKey, filtered, groups, sidebarEntries, groupedSessions: displayedSessions,
    validateGroupName, saveGroup, editProject, removeGroup, toggleProject, expandProject, moveSession, placeSidebarEntry, projectParent, canMoveProject, moveProject, groupEntries, placeGroupEntry,
  };
}
