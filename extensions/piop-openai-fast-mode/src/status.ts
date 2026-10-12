import { STATUS_KEY, type ModelRef } from "./types";
import { isSupportedProvider } from "./payload";

export type StatusText = "fast" | undefined;

export type FastIndicatorComponent = {
  render(width: number): string[];
  invalidate(): void;
};

export type FastIndicatorFactory = (
  ...args: unknown[]
) => FastIndicatorComponent;

export type StatusContext = {
  hasUI?: boolean;
  mode?: string;
  ui?: {
    setStatus?: (key: string, text: string | undefined) => void;
    setWidget?: {
      (
        key: string,
        content: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
      (
        key: string,
        content: FastIndicatorFactory | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
    };
  };
};

export function getStatusText(
  enabled: boolean,
  model: ModelRef | undefined,
): StatusText {
  return enabled && model && isSupportedProvider(model.provider) ? "fast" : undefined;
}

export function getRightAlignedStatusLine(text: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));

  if (safeWidth === 0) return "";

  if (text.length >= safeWidth) return text.slice(0, safeWidth);

  return `${" ".repeat(safeWidth - text.length)}${text}`;
}

export function createFastIndicatorFactory(text: string): FastIndicatorFactory {
  return () => ({
    render(width: number): string[] {
      return [getRightAlignedStatusLine(text, width)];
    },
    invalidate(): void {},
  });
}

export function canSetTuiStatus(ctx: StatusContext): boolean {
  if (!ctx.hasUI) return false;

  if (ctx.mode !== undefined && ctx.mode !== "tui") return false;

  return (
    ctx.ui?.setWidget !== undefined ||
    ctx.ui?.setStatus !== undefined
  );
}

function setFastIndicator(ctx: StatusContext, text: StatusText): void {
  if (ctx.ui?.setWidget !== undefined) {
    ctx.ui.setStatus?.(STATUS_KEY, undefined);
    ctx.ui.setWidget(
      STATUS_KEY,
      text === undefined ? undefined : createFastIndicatorFactory(text),
      { placement: "belowEditor" },
    );

    return;
  }

  ctx.ui?.setStatus?.(STATUS_KEY, text);
}

export function updateFastStatus(
  ctx: StatusContext,
  enabled: boolean,
  model: ModelRef | undefined,
): void {
  if (!canSetTuiStatus(ctx)) return;
  setFastIndicator(ctx, getStatusText(enabled, model));
}

export function clearFastStatus(ctx: StatusContext): void {
  if (!canSetTuiStatus(ctx)) return;
  setFastIndicator(ctx, undefined);
}
