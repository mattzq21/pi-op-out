import { createMemo,type Accessor } from "solid-js";
import type { SessionSummary } from "../types";
import { hasVisibleText } from "./content";
import { DIRLESS_KEY,projectGroupId,isTemporaryChatCwd,useSessionGroups, type SessionGroup } from "./sessionGroups";
import { useSessionProjects } from "./sessionProjects";
import { createDependencyEffect } from "./solid";
import { createSidebarPersistence, moveSidebarToken } from "./sidebarPersistence";

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

function validSessionOrders(orders: Record<string, string[] | undefined>) {
  return Object.fromEntries(Object.entries(orders).flatMap(([key, sessions]): [string, string[]][] => sessions ? [[key, sessions]] : []));
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

  return [...sessions].sort((left, right) => {
    const leftPosition = positions.get(sessionKey(left)); const rightPosition = positions.get(sessionKey(right));

    if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;

    if (leftPosition !== undefined) return projectKey === RECENT_KEY ? 1 : -1;

    if (rightPosition !== undefined) return projectKey === RECENT_KEY ? -1 : 1;

    return defaultOrder(left, right);
  });
}

export type SidebarState = ReturnType<typeof createSidebarState>;

export function createSidebarState(source: Accessor<SessionSummary[]>, query: Accessor<string>, projects?: ReturnType<typeof useSessionGroups>) {
  const sessions = createMemo(() => {
    const parents = new Set(source().map(session => `${session.hostId ?? "local"}:${session.id}`));

    return source().filter(session => !session.subagentParentId || !parents.has(`${session.hostId ?? "local"}:${session.subagentParentId}`));
  });

  const storedGroups = projects ?? useSessionProjects();
  const savedGroups = createMemo(() => storedGroups.state?.groups ?? []);
  const savedGroupsById = createMemo(() => new Map(savedGroups().map((group): [string, SessionGroup] => [group.id, group]).reverse()));
  const customGroups = createMemo(() => savedGroups().filter(group => !group.cwd && group.id !== DIRLESS_KEY));
  const persistence = createSidebarPersistence();
  const collapsedProjects = createMemo(() => new Set(persistence.layout().collapsed));
  const sessionOrders = createMemo(() => validSessionOrders(persistence.layout().sessions));
  const sidebarOrder = () => persistence.layout().sidebar;
  const projectGroups = () => storedGroups.state?.parents ?? {};
  const groupChildOrders = () => persistence.layout().children;
  const setCollapsedProjects = (update: (current: Set<string>) => Set<string>) => persistence.change("collapsed", current => [...update(new Set(current))]);
  const setSessionOrders = (update: (current: Record<string, string[]>) => Record<string, string[]>) => persistence.change("sessions", current => update(validSessionOrders(current)));
  const setSidebarOrder = (update: (current: string[]) => string[]) => persistence.change("sidebar", update);
  const setGroupChildOrders = (update: (current: Record<string, string[]>) => Record<string, string[]>) => persistence.change("children", update);

  const projectParent = (id: string) => {
    const parent = projectGroups()[id];

    return !isFixedGroup(id) && savedGroupsById().has(id) && customGroups().some(group => group.id === parent) ? parent : undefined;
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

    if (!customGroups().some(group => group.id === parent) || parent === id) return false;
    const ancestors = groupAncestors(parent);

    if (ancestors.includes(id)) return false;
    const customIds = new Set(customGroups().map(group => group.id));

    const subtreeHeight = (key: string): number => customIds.has(key)
      ? 1 + Math.max(0, ...customGroups().filter(group => projectParent(group.id) === key).map(group => subtreeHeight(group.id)))
      : 0;

    return ancestors.length + 1 + subtreeHeight(id) <= 3;
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

  const removeGroup = async (projectKey: string) => { const capturedSessions = sessions(); const capturedSessionOrders = sessionOrders();
    const releasedSessions = orderedSessions(projectKey, capturedSessions.filter((session) => visualProjectKey(session) === projectKey), capturedSessionOrders);
    const releasedTokens = releasedSessions.map((session) => sessionLayoutToken(sessionKey(session)));
    await storedGroups.change({ type: "remove", id: projectKey });
    persistence.removeGroup(projectKey, releasedTokens);
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
    placeGroupEntry(destinationKey, sessionLayoutToken(key), before);
  };

  const moveSession = (drag: DraggedSession, destinationKey: string, targetKey?: string, edge: "before" | "after" = "after") => {
    if (destinationKey === DIRLESS_KEY && drag.projectKey !== DIRLESS_KEY) return;
    const destinationSessions = displayedSessions().get(destinationKey);

    if (!destinationSessions) return;

    if (drag.projectKey === destinationKey && drag.sessionKey === targetKey) return;
    const available = destinationSessions.map(sessionKey);
    setSessionOrders((current) => {
      const order = [...(current[destinationKey] ?? []), ...available.filter(key => !current[destinationKey]?.includes(key))].filter(key => key !== drag.sessionKey);
      const targetIndex = targetKey ? order.indexOf(targetKey) : -1;
      const before = targetIndex < 0 ? null : edge === "before" ? targetKey ?? null : order[targetIndex + 1] ?? null;
      const next = { ...current, [destinationKey]: moveSidebarToken(order, drag.sessionKey, before) };

      return next;
    });

    if (customGroupsByKey().has(destinationKey)) {
      placeSessionEntry(destinationKey, drag.sessionKey, targetKey, edge);
    }

    if (destinationKey === DIRLESS_KEY) return Promise.resolve();

    return storedGroups.change({ type: "assign", key: drag.sessionKey, group: destinationKey === RECENT_KEY ? null : destinationKey }).catch(() => undefined);
  };

  const placeSidebarEntry = (token: string, beforeToken: string | null) => {
    if ([RECENT_KEY, DIRLESS_KEY].some(key => token === groupLayoutToken(key))) return;
    const currentEntries = sidebarEntries();

    if (beforeToken === token) return;
    setSidebarOrder(current => moveSidebarToken(current, token, beforeToken ?? groupLayoutToken(RECENT_KEY), currentEntries));
  };

  const groupDestination = (id: string) => savedGroupsById().get(id);

  const projectDetails = createMemo(() => {
    const details = new Map<string, SessionSummary>();
    sessions().forEach(session => { const key = projectGroupId(session);

    if (!details.has(key)) details.set(key, session); });

    return details;
  });

  const normalizedQuery = createMemo(() => (query().trim().toLowerCase()));
  const customGroupsByKey = createMemo(() => (new Map(customGroups().map((group) => [group.id, group]))));

  const draftProjectGroup = (session: SessionSummary) => session.isDraft && session.cwd ? savedGroups().find(group => group.cwd === session.cwd && (group.hostId ?? "local") === (session.hostId ?? "local"))?.id : undefined;

  const visualProjectKey = (session: SessionSummary) => {
    if (session.cwdExists === false) return DIRLESS_KEY;
    const destination = storedGroups.state?.assignments[sessionKey(session)] ?? draftProjectGroup(session);

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
  createDependencyEffect(() => { const capturedNormalizedQuery = normalizedQuery(); const capturedRecentKeys = recentKeys();

    if (capturedNormalizedQuery) return;
    setSessionOrders((current) => {
      const saved = current[RECENT_KEY];

      if (!saved) return current;
      const known = new Set(saved);
      const added = capturedRecentKeys.split("\n").filter((key) => key && !known.has(key));

      if (!added.length) return current;
      const next = { ...current, [RECENT_KEY]: [...added, ...saved] };

      return next;
    });
  }, () => [recentKeys(), normalizedQuery()]);
  const physicalGroups = createMemo(() => (savedGroups().filter((group) => group.cwd && !isTemporaryChatCwd(group.cwd)).map((group): SidebarGroup => [group.id, group.name, group.hostId ?? "local", group.hostName ?? undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())])));
  const customVisualGroups = createMemo(() => (customGroups().map((group): SidebarGroup => [group.id, group.name, "", undefined, orderedSessions(group.id, groupedSessions()[group.id] ?? [], sessionOrders())])));
  const projectOrderKey = createMemo(() => (JSON.stringify(savedGroups().map((group) => groupLayoutToken(group.id)))));
  createDependencyEffect(() => { const capturedProjectOrderKey = projectOrderKey();
    const projectTokens: string[] = JSON.parse(capturedProjectOrderKey);
    setSidebarOrder((current) => {
      const added = projectTokens.filter((token) => !current.includes(token));

      if (!added.length) return current;
      const next = [...added, ...current];

      return next;
    });
  }, () => [projectOrderKey()]);

  const groups = createMemo<SidebarGroup[]>(() => ([
    ...customVisualGroups().filter(([key, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0 || [...customVisualGroups(), ...physicalGroups()].some(([id, , , , children]) => children.length > 0 && groupAncestors(id).includes(key))),
    ...physicalGroups().filter(([, , , , projectSessions]) => !normalizedQuery() || projectSessions.length > 0),
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
    if (token === before) return;
    const entries = groupEntries(id);
    setGroupChildOrders(current => {
      const next = { ...current, [id]: moveSidebarToken(current[id] ?? [], token, before, entries) };

      return next;
    });
  };

  const saveGroup = (name: string, id?: string, project?: Pick<SessionGroup, "cwd" | "hostId" | "hostName">) => {
    if (id) return storedGroups.change({ type: "rename", id, name });

    if (project?.cwd) return storedGroups.change({ type: "project", project: { ...project, id: `__pi-desktop-custom-group__:${crypto.randomUUID()}`, name } });

    return storedGroups.change({ type: "create", name });
  };

  return {
    get state() { return storedGroups.state; }, get error() { return storedGroups.error ?? persistence.error(); },
    sessions, collapsedProjects, customGroupsByKey, groupDestination, projectDetails,
    normalizedQuery, visualProjectKey, filtered, groups, sidebarEntries, groupedSessions: displayedSessions,
    validateGroupName, saveGroup, removeGroup, toggleProject, expandProject, moveSession, placeSidebarEntry, projectParent, canMoveProject, moveProject, groupEntries, placeGroupEntry,
  };
}
