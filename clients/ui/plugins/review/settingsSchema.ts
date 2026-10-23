import { z } from "zod";

export const reviewSettingsSchema = z.object({ reviewAgent: z.string().optional() });
