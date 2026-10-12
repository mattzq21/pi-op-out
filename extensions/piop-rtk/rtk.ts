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

export default function (pi: ExtensionAPI) {
  let enabled = false

  pi.on("session_start", async (_event, ctx) => {
    enabled = false

    try {
      const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })

      if (ver.killed || ver.code !== 0) throw new Error("rtk version check failed; check that rtk is in PATH")
      const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))

      if (!parsed) throw new Error("Could not read the rtk version")

      if (parsed[0] === 0 && parsed[1] < MIN_SUPPORTED_RTK_MINOR) {
        throw new Error(`rtk ${parsed.join(".")} is too old (need >= 0.23.0)`)
      }

      ctx.ui.setStatus("rtk", undefined)
      enabled = true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[rtk] ${reason} — extension disabled`)
      ctx.ui.setStatus("rtk", `RTK disabled: ${reason}`)
    }
  })

  pi.on("session_shutdown", () => { enabled = false })

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!enabled || !isBashToolCallEvent(event)) return

      const cmd = event.input.command

      if (cmd.trim() === "") return

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
