# Free runtime — replaces Orgo, xAI voice, Composio

Blueprint rule (MAUS-R-03, MAUS-E2E-077): free/local must never silently fall through to a paid provider.

| Paid service | Free replacement | When it is used |
|---|---|---|
| Orgo computer | `HQ_LOCAL=1` local box + virtual screens | No Orgo key. Shell/files run on this host. Desktop stream still needs a display; status is `running` without calling Orgo. |
| xAI / Grok voice | Browser speech recognition + speech synthesis | No `XAI_API_KEY`. Session `provider=local`. Recognized speech is sent to the agent as a chat message. |
| Composio | Built-in local connectors (files, shell, MCP tools, device voice) | No `COMPOSIO_API_KEY`. `GET /api/apps` returns the local catalog. |

Paid keys remain optional upgrades. They are never selected just because a free path failed.

This does not close the rest of `universal_agent_platform_master_blueprint_v6_sid_workforce1.md`. That document is the product contract. This file is the free substrate those sections require before the rest can run without vendor accounts.
