import { nativePlugin } from "../native";
export { isMobile } from "../../lib/platform";

export const { invoke, listen } = nativePlugin("dictation", "Dictation", {
  dictation_configuration: "configuration", dictation_find_engines: "findEngines",
  dictation_stream_start: "start", dictation_stream_feed: "feed", dictation_stream_finish: "finish", dictation_stream_cancel: "cancel",
}, { "pi://dictation": "dictation", "pi://dictation-stream": "dictation-stream" });
