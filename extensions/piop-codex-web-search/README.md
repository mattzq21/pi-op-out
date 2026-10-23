# Pi Codex web search

A single-file Pi extension exposing `web_search({ query, domains? })`. It returns a web-grounded answer and source URLs using the host's existing Pi Codex login. No extra npm dependencies, search API keys, browser, or MCP server are needed.

Piop embeds the source and automatically loads it in local and SSH sessions, including side conversations. Rebuild/restart Piop to pick it up. `web_search` is enabled by default in Settings → Tools and for agents, including existing profiles on their first launch with this update. You can disable it under Settings → Agents or Settings → Tools; later launches preserve that choice. Each SSH host needs its own Pi Codex login.

For standalone Pi, from this repository:

```bash
pi --extension ./extensions/piop-codex-web-search/index.ts
```

Example tool arguments:

```json
{"query":"What changed in the latest stable Rust release?","domains":["blog.rust-lang.org"]}
```

The current Codex model performs the search. When chatting with another provider, the extension picks a registered Codex model using upstream's preference for Terra, then a mainline GPT model, then another non-Pro/non-Ultra model. `PIOP_WEB_SEARCH_MODEL` can override this with a registered Codex model ID; set it in the Pi process environment on the executing host. Search requests consume that host's Codex usage. Unsupported models produce a tool error instead of falling back to another provider.

## How the extraction works

Adapted from [`openai-search.ts` in pi-web-access](https://github.com/nicobailon/pi-web-access/blob/811ef82a6dd04fe4abd73fa40b079aa39ee1870d/openai-search.ts), pinned at `811ef82a6dd04fe4abd73fa40b079aa39ee1870d`. The upstream MIT license is retained in `LICENSE` and in the staged source header.

1. Resolve credentials through `ctx.modelRegistry.getApiKeyAndHeaders`, allowing Pi to handle OAuth refresh. Extract `chatgpt_account_id` from the access token.
2. POST a separate request to `https://chatgpt.com/backend-api/codex/responses` with bearer authentication, the account header, and `originator: pi`.
3. Supply hosted `web_search` with `tool_choice: required`, `store: false`, `stream: true`, and `include: ["web_search_call.action.sources"]`. Only the search query is sent, not the conversation history.
4. Parse the completed SSE response, require an actual web search call, and return answer text plus deduplicated citation/source URLs. Cancellation and a 60-second timeout propagate through the request. Incomplete and failed streams produce errors.

This wraps a model's hosted search capability; it does not invoke a Codex CLI process or expose the Codex app's full `web.run` interface. The hosted search request format is described in [OpenAI's web search documentation](https://developers.openai.com/api/docs/guides/tools-web-search); the subscription endpoint and headers follow the upstream implementation.

The extraction omits upstream's other providers, API-key configuration, curator UI, page scraping, video tools, caching, and background jobs. A query can ask for recent sources or information from a URL, but there is no standalone page-fetch tool. Do not load this alongside another extension registering `web_search` (including the full `pi-web-access`).
