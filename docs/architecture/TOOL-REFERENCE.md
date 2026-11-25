# Tool reference (generated — do not hand-edit)

Generated from the kernel's own classification; regenerate with `node --import tsx scripts/generate-tool-docs.mjs`.

## `save_file`

- **Label:** Saving a file
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `create_routine`

- **Label:** Setting up a routine
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `stay_silent`

- **Label:** Finishing up
- **Effect:** write
- **Risk tier:** low
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `set_checkins`

- **Label:** Updating check-ins
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_routines`

- **Label:** Checking routines
- **Effect:** read
- **Risk tier:** low
- **Approval by default:** no
- **Idempotent:** yes — safe to retry
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout

## `update_routine`

- **Label:** Updating a routine
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `delete_routine`

- **Label:** Removing a routine
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `create_task`

- **Label:** Making a task
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `update_task`

- **Label:** Updating a task
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `send_to_bot`

- **Label:** Messaging a Bot
- **Effect:** external_message
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `create_group`

- **Label:** Setting up a group
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `post_to_group`

- **Label:** Posting to the group
- **Effect:** external_message
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `ask_user`

- **Label:** Waiting on you
- **Effect:** write
- **Risk tier:** low
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_sid_templates`

- **Label:** Listing SID templates
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `install_sid_template`

- **Label:** Installing a SID agent
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `spawn_sid_subagent`

- **Label:** Spawning a sub-agent
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** yes (ask-mode gated)
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `set_autonomy`

- **Label:** Setting autonomy
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `remember`

- **Label:** Saving a note
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `dispatch_specialist`

- **Label:** Dispatching a specialist
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `accept_build`

- **Label:** Checking the release gate
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_domain`

- **Label:** Reading domain gates
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_live`

- **Label:** Reading live execution
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_board`

- **Label:** Reading the board
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error

## `list_workspace`

- **Label:** Reading the workspace
- **Effect:** write
- **Risk tier:** medium
- **Approval by default:** no
- **Idempotent:** no — do not auto-retry without a dedupe key
- **Error families:** engine_unreachable, engine_auth, provider_auth, provider_rate_limited, provider_unavailable, timeout, tool_error
