import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const instructions = `Piop renders fenced mermaid blocks as interactive diagrams and charts in conversation messages. Use them proactively when a visual makes architecture, dependencies, request flows, state transitions, timelines, or quantitative comparisons easier to understand. Prefer a small, focused diagram over a long prose description of relationships; skip visuals for simple answers.

Use Mermaid flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, timeline, pie, or xychart-beta syntax as appropriate. Use short plain-text labels, stable node identifiers, and an accTitle/accDescr where supported. Close every fence. Do not include Mermaid configuration directives, frontmatter, HTML, external images, or click handlers; piop controls appearance and interaction. Use only observed or supplied values in charts, and clearly label estimates. Keep the explanation beside the diagram concise.`;

export default function diagrams(pi: ExtensionAPI) {
  pi.on("before_agent_start", event => ({
    systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
  }));
}
