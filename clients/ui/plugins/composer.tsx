import { createContext, For, useContext, type Accessor, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ComposerToolProps } from "./types";

export const ComposerPluginsContext = createContext<Accessor<Component<ComposerToolProps>[]>>();

export function ComposerPlugins(props: ComposerToolProps) {
  const extensions = useContext(ComposerPluginsContext);
  return <For each={extensions?.()}>{extension => <Dynamic component={extension} {...props} />}</For>;
}
