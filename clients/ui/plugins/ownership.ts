import { z } from "zod";

export const ownershipSchema = z.object({ owned: z.boolean(), available: z.boolean() });

export type PluginOwnership = z.infer<typeof ownershipSchema>;
