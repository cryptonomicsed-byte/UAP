# Hermes adapter mapping and conversation lifecycle

Status: implemented in `server/src/agent/hermes-adapter.ts`; pinned by
`tests/hermes-adapter-lifecycle.test.mjs`. Checklist items: **V6-07-01** (map the
OpenMausBot ACP Hermes adapter onto the real gateway and tool semantics) and
**V6-07-07** (model swap and runtime restart must not leak another SID's conversation).

The OpenMausBot ACP adapter is reference only. This app does not speak ACP to Hermes:
it calls the Hermes gateway's HTTP API and reads its event stream. The table below is
the mapping, one row per concept. Each row carries the file and literal that prove the
call exists; the test re-reads those files, so a row that outlives its code fails the
build. `unsupported` rows name what is missing instead of claiming parity.

## Surface

| Adapter concept | Verdict | Hermes gateway | Limitation |
|---|---|---|---|
| `session/new` | partial | `POST /v1/responses`, field `conversation` | The client names the thread; the gateway does not mint a session id we can read back. |
| `session/prompt` | mapped | `POST /v1/responses`, `input` + app `instructions` | — |
| `session/update` | mapped | SSE on the same response: `response.output_text.delta`, `response.reasoning_*_delta`, `response.output_item.added|done`, `hermes.status` | — |
| `session/cancel` | partial | abort of the HTTP request (`signal`) | Client-side only: the gateway is not told to stop the run, and `store: true` means it may still record the transcript. |
| `session/load` | partial | history kept by the gateway (`store: true`), resumed by conversation name | No load/attach handshake, and no proof here against a live gateway. |
| `session/request_permission` | partial | app approval cards + the app's MCP tools | The permission round trip is ours, not an ACP request back to the adapter. |
| `tool execution` | partial | Hermes executes its own tools; `function_call` / `function_call_output` items are observed | This app runs none of the model's tools for it. |
| `mcp discovery` | unsupported | — | The app serves `/mcp/<botId>`; pointing a gateway at it is operator configuration and is unproven here. |
| `model selection` | mapped | `GET /api/model/options` is the only model authority; turns send the `hermes-agent` alias | — |
| `engine key check` | mapped | `GET /v1/models` with the managed home's key | — |
| `health` | mapped | `GET /health` | — |

## Conversation lifecycle

An engine-side thread is named `hq-<sid>-g<generation>` when the agent is bound to an
issued SID, and `hq-<botId>-g<generation>` for an agent not yet bound. The name is a
pure function of the SID and the chat generation:

- **Model swap** — the thread name has no model or provider component, so changing the
  model in Hermes configuration resumes the same thread. The existing model-authority
  test keeps the gateway as the only source of the displayed model.
- **Runtime restart** — nothing about the thread lives in process memory. A restarted
  server derives the same name from the stored SID and generation, so the SID resumes
  its history; a different SID derives a different name and cannot receive it.
- **Rebinding** — `bindConversationSid` refuses to put a second agent on a SID already
  in use (`sid_in_use`) and refuses to re-label a generation that already has rows
  (`sid_rebind_requires_new_generation`); open a new chat first. Agents bound before
  SID issuance keep the legacy bot-id thread; no SID is invented for them. The operator
  command is `npm run agents:bind-sid -- --bot <botId> --sid <sid_slug>` (dry run by
  default; `--apply` writes `bots.sid`).

The restart case is tested with one SQLite database opened by two separate node
processes and a fixture gateway that echoes the conversation name it was given: the
first process runs SID A, the second runs SID B and then SID A again after a model
swap, and the test asserts the request log is exactly
`hq-sid_alpha-g1`, `hq-sid_beta-g1`, `hq-sid_alpha-g1`, each under its own engine key,
with no transcript row crossing agents.

## Not claimed

- No live-gateway proof of stream resumption or gateway-side cancellation; both are
  `partial` above and stay open until a real gateway run is recorded.
- Gateway-side MCP discovery remains `unsupported`.
- V6-07-02 (tool calling, delegation and Composio/MCP discovery against real permitted
  providers) needs live credentials; nothing here substitutes for that run.
