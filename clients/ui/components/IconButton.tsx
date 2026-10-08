import { splitProps } from "solid-js";
import { type ButtonHTMLAttributes, type JSXElement } from "../lib/solid";

export function IconButton(componentProps: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: JSXElement }) {
  const [, props] = splitProps(componentProps, ["label", "children", "class", "title"]);

  return <button class={`icon-button ${(componentProps.class === undefined ? "" : componentProps.class)}`} aria-label={componentProps.label} data-tooltip={componentProps.title ?? componentProps.label} {...props}>{componentProps.children}</button>;
}
