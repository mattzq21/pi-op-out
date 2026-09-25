import { createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor, type JSX } from "solid-js";

export type StateUpdate<T> = T | ((previous: T) => T);
export type Dispatch<T> = (value: T) => void;
export type RefObject<T> = { current: T };
export type JSXElement = JSX.Element;
export type CSSProperties = JSX.CSSProperties;
export type ButtonHTMLAttributes<T> = JSX.ButtonHTMLAttributes<T>;
export type KeyboardEvent<T = EventTarget | null> = globalThis.KeyboardEvent & { currentTarget: T };
export type MouseEvent<T = EventTarget | null> = globalThis.MouseEvent & { currentTarget: T };
export type PointerEvent<T = EventTarget | null> = globalThis.PointerEvent & { currentTarget: T };

export const cssPixels = (value: string | number | undefined) => typeof value === "number" ? `${value}px` : value;

export function createMemoFields<T extends object>(source: Accessor<T>): T {
  const value = createMemo(source);
  const fields = {} as T;
  for (const key of Object.keys(value()) as Array<keyof T>) {
    const field = createMemo(() => value()[key]);
    Object.defineProperty(fields, key, { enumerable: true, get: field });
  }
  return fields;
}

declare module "solid-js" {
  namespace JSX {
    interface CustomCaptureEvents { keydown: globalThis.KeyboardEvent; focus: FocusEvent; pointerdown: globalThis.PointerEvent; }
  }
}

export function createRef<T>(value: T): RefObject<T>;
export function createRef<T>(value: T | null): RefObject<T | null>;
export function createRef<T>(value: T) { return { current: value }; }

export function createDependencyEffect(effect: () => unknown, dependencies?: Accessor<readonly unknown[]>) {
  const run = () => {
    const cleanup = effect();
    if (typeof cleanup === "function") onCleanup(cleanup as () => void);
  };
  if (!dependencies) { createEffect(run); return; }
  const values = createMemo(dependencies, undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((value, index) => Object.is(value, next[index])),
  });
  createEffect(on(values, run));
}

export function createSubscription<T>(subscribe: Accessor<(listener: () => void) => () => unknown>, snapshot: Accessor<() => T>): Accessor<T> {
  const [value, setValue] = createSignal<T>(snapshot()());
  createComputed(() => {
    const read = snapshot();
    const update = () => setValue(() => read());
    const stop = subscribe()(update);
    update();
    onCleanup(() => { stop(); });
  });
  return value;
}
