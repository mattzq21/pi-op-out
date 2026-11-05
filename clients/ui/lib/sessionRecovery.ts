import { nativeCall } from "./nativeCall";

export const recoverSessionDirectory = (sessionPath: string, hostId = "local") => nativeCall("recover_missing_session", { sessionPath, hostId, action: "empty" });
