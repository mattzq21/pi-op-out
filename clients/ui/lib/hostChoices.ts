import type { AppSettings } from "../types";
import { localHostLabel } from "./mobileHosts";

export function hostChoices(settings: Pick<AppSettings, "localEnabled" | "hosts">) {
  return [{ id: "local", name: localHostLabel(), disabled: settings.localEnabled === false }, ...settings.hosts.filter(host => host.enabled !== false)];
}
