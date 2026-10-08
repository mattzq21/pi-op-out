import { z } from "zod";

export const extensionUiSchema = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.enum(["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]),
  title: z.string().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  prefill: z.string().optional(),
  notifyType: z.enum(["info", "warning", "error"]).optional(),
  statusKey: z.string().optional(),
  statusText: z.string().optional(),
  widgetKey: z.string().optional(),
  widgetLines: z.array(z.string()).optional(),
  widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
  text: z.string().optional(),
});
