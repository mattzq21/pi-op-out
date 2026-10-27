import { z } from "zod";

export const webSearchSettingsSchema = z.object({ webSearchModel: z.string().optional() });
