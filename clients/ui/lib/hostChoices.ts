import type { AppSettings } from "../types";
import { cachedMobileHostName } from "./mobileHosts";
import { isMobile } from "./platform";

export function localHostLabel() { return isMobile ? cachedMobileHostName() ?? "Anchor host" : "Local"; }

export function hostChoices(settings: Pick<AppSettings, "localEnabled" | "hosts">) {
  return [{ id: "local", name: localHostLabel(), disabled: settings.localEnabled === false }, ...settings.hosts.filter(host => host.enabled !== false)];
}
