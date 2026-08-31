# lamarck adapter: generic fallback

The escape hatch. The primary path for a new harness is self-service (its
own agent writes a bespoke adapter and gates on the conformance verifier -
see `protocol/adapter-contract.md`). When that fails the attempt budget
(three red verifier runs), fall back to this pair: lamarck-provided
function adapters that assume only the lowest common denominator -
**a JSON object on stdin, stdout read back** - and make the two
harness-specific facts configuration instead of code:

1. **Which events to wire** - a post-tool event for `posttool.js`, a
   turn-end event for `stop.js`. That is the wiring step, nothing else.
2. **Which output envelope the turn-end hook consumes** - pass `--emit=`
   to `stop.js`:

   | `--emit=` | writes | style |
   |---|---|---|
   | `block` (default) | `{"decision":"block","reason":...}` | Claude Code / Codex |
   | `followup` | `{"followup_message":...}` | Cursor |
   | `text` | the protocol as plain stdout | harnesses that append hook stdout as context |

Field extraction is tolerant by design: session identity from
`session_id` / `conversation_id` / `thread_id` / `sessionId` / `session`,
transcript from `transcript_path` variants, and the activation signal is a
`.../<skill>/SKILL.md` path anywhere in the payload (transcript- and
workspace-like fields excluded). `stop_hook_active` is honored when the
harness sends one; a per-session cooldown latch covers harnesses that do
not.

The cost of generality: `args` telemetry is thinner than a bespoke
adapter's, and a harness whose session key or path shapes fall outside the
candidates yields `session=""` entries (drained only by manual runs) -
which is degradation, not breakage. If the verifier passes a bespoke
adapter later, switch to it and keep the ledger; the store is shared
either way.

Wire it exactly like the other command adapters (absolute paths, node as
the runner) and confirm with:

```
node scripts/verify-adapter.js adapters/generic/manifest.json
```

## Verification status

Passes the same conformance verifier as the bespoke adapters, with samples
spanning three different field conventions plus a Windows-backslash path.
By construction it cannot be validated against every unknown harness -
that is what the tolerant extraction and fail-closed posture are for.
