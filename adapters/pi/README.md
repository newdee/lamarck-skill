# lamarck adapter: pi

pi's extension API covers all three adapter roles in-process: `tool_call`
events observe skill activations (collector), `agent_settled` marks turn
end (trigger), and `pi.sendMessage(..., { deliverAs: "followUp" })` hands
the model the rendered light-loop protocol (executor) - the same
free-rider pattern as the Claude Code Stop hook, with zero extra API cost.

pi natively implements the Agent Skills standard and can reuse Claude's
skill directory:

```json
{ "skills": ["~/.claude/skills"] }
```

so the genomes lamarck watches are the same files across both harnesses.

## Wiring

1. Copy (or symlink) `lamarck.ts` into `~/.pi/agent/extensions/`.
2. If lamarck is not at `~/.claude/skills/lamarck`, set `LAMARCK_HOME`.
3. `/reload` inside pi, or restart it.

The extension renders `protocol/light-loop.md` itself (same stripping,
whitespace collapsing and `{{BACKLOG}}` substitution as the reference
adapter) and writes to the shared telemetry store - one ledger per
machine across every harness.

## Notes and limits

- pi has no dedicated Skill tool: activation = the model reading a
  `SKILL.md`, which is what the collector matches. Over-collection is
  judged downstream by the light loop's `trigger_fit` verdict.
- Session identity is synthesized per pi process (pi does not portably
  expose its session file path to extensions); transcript pointers are
  left empty, so channel-B re-evaluation falls back to archiving, as the
  protocol allows.
- Re-entry guard: the evaluation turn's own `agent_settled` is skipped
  once; pending cleanup is the durable loop guard.
- `isolation: subagent` does not apply: pi extensions have no subagent
  mechanism, so the evaluation runs inline (the QUIETLY clause still caps
  visible narration at two lines).

## Verification status

Written against pi's published extension API and validated only by static
review plus the shared-store schema tests in this repo - not yet run
inside a live pi install. Field reports welcome. Fails closed: every
handler swallows its errors into `data/hook-errors.log` and pi is never
blocked.
