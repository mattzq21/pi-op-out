import { z } from "zod";

// How the sidebar groups the chats of all hosts: groups and projects, which chat is in which group, and the orders.

export const ORDER_SCOPES = ["sidebar", "sessions", "children"] as const;
export type OrderScope = typeof ORDER_SCOPES[number];

const text = z.string().nullish().transform(value => value ?? null);

export const sessionGroupSchema = z.object({ id: z.string(), name: z.string(), cwd: text, hostId: text, hostName: text });
export type SessionGroup = z.output<typeof sessionGroupSchema>;

// A chat that the client knows about, with the project it belongs to and the chat it was branched from.
export const sessionSeedSchema = z.object({ sessionKey: z.string(), project: sessionGroupSchema, parentKey: z.string().nullish().transform(value => value ?? undefined).optional() })
  .refine(seed => seed.parentKey !== seed.sessionKey, "A chat cannot be branched from itself");
export type SessionSeed = z.output<typeof sessionSeedSchema>;

const singleChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), name: z.string() }),
  z.object({ type: z.literal("project"), project: sessionGroupSchema, key: text }),
  z.object({ type: z.literal("relocate"), project: sessionGroupSchema, key: z.string() }),
  z.object({ type: z.literal("rename"), id: z.string(), name: z.string() }),
  z.object({ type: z.literal("edit"), id: z.string(), name: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("remove"), id: z.string() }),
  z.object({ type: z.literal("assign"), key: z.string(), group: text }),
  z.object({ type: z.literal("move"), id: z.string(), parent: text }),
  z.object({ type: z.literal("order"), scope: z.enum(ORDER_SCOPES), owner: z.string(), visible: z.array(z.string()), token: text, before: text }),
]);

// One change, or a batch of changes that is saved fully or not at all. A batch cannot contain another batch.
export const groupChangeSchema = z.union([singleChangeSchema, z.object({ type: z.literal("batch"), changes: z.array(singleChangeSchema) })]);
export type GroupChange = z.output<typeof groupChangeSchema>;
export type SingleGroupChange = z.output<typeof singleChangeSchema>;
export type GroupChangeInput = z.input<typeof groupChangeSchema>;

export const sessionGroupOrdersSchema = z.object({ sidebar: z.array(z.string()), sessions: z.record(z.string(), z.array(z.string())), children: z.record(z.string(), z.array(z.string())) });

export const sessionGroupsSchema = z.object({
  groups: z.array(sessionGroupSchema), parents: z.record(z.string(), z.string()), assignments: z.record(z.string(), z.string().nullable()),
  removedProjects: z.array(z.string()), orders: sessionGroupOrdersSchema,
});
export type SessionGroupsView = z.output<typeof sessionGroupsSchema>;
