import { z } from "zod";
import { nativeCall } from "./nativeCall";

export const recoverSessionDirectory = (sessionPath: string, hostId = "local") => nativeCall("recover_missing_session", { sessionPath, hostId, action: "empty" }, z.object({ cwd: z.string(), warnings: z.array(z.string()) }));
