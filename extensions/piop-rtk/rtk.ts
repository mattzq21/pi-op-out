import type {
  BashToolCallEvent,
  ExtensionAPI,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000
const MIN_SUPPORTED_RTK_MINOR = 23

function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash"
}

function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

async function rewriteCommand(
  pi: ExtensionAPI,
  cmd: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await pi.exec("rtk", ["rewrite", cmd], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  })
  if (result.killed) return null
  if (result.code !== 0 && result.code !== 3) return null
  return result.stdout.trim() || null
}

type StatusContext = {
  ui?: {
    setStatus?: (key: string, text: string) => void
  }
}

function registerRtkUnavailableNotice(pi: ExtensionAPI) {
  let reason: string | undefined
  let sessionContext: StatusContext | undefined

  const applyStatus = () => {
    if (!reason || !sessionContext) return
    try {
      sessionContext.ui?.setStatus?.("rtk", `RTK disabled: ${reason}`)
    } catch {
    }
  }

  try {
    pi.on("session_start", (_event: unknown, ctx: unknown) => {
      sessionContext = ctx as StatusContext
      applyStatus()
    })
  } catch {
    return (_reason: string) => {}
  }

  return (nextReason: string) => {
    reason = nextReason
    applyStatus()
  }
}

export default async function (pi: ExtensionAPI) {
  const reportRtkUnavailable = registerRtkUnavailableNotice(pi)

  const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  if (ver.code !== 0) {
    reportRtkUnavailable("rtk binary not found in PATH")
    console.warn("[rtk] rtk binary not found in PATH — extension disabled")
    return
  }

  const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))
  if (parsed) {
    const [major, minor] = parsed
    if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
      reportRtkUnavailable(`rtk ${parsed.join(".")} is too old (need >= 0.23.0)`)
      console.warn(`[rtk] rtk ${ver.stdout.trim()} is too old (need >= 0.23.0) — extension disabled`)
      return
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isBashToolCallEvent(event)) return

      const cmd = event.input.command
      if (typeof cmd !== "string" || cmd.trim() === "") return

      if (cmd.startsWith("rtk ")) return
      if (process.env.RTK_DISABLED === "1") return

      const rewritten = await rewriteCommand(pi, cmd, ctx.signal)
      if (rewritten && rewritten !== cmd) {
        event.input.command = rewritten
      }
    } catch (err) {
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", err)
      return
    }
  })
}
