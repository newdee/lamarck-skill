// lamarck adapter: pi (pi.dev) extension - all three adapter roles.
//
// Install: copy or symlink this file into ~/.pi/agent/extensions/
// (hot-reload with /reload). lamarck itself stays in ~/.claude/skills/lamarck;
// override with the LAMARCK_HOME environment variable.
//
// Roles (see ../../protocol/adapter-contract.md):
// - collector: pi has no dedicated Skill tool - a skill activates when the
//   model READS its SKILL.md (pi's own docs describe activation as a `read`
//   of the skill file). We watch tool_call events for such paths and append
//   a pending line. Over-collection is judged downstream by trigger_fit.
// - trigger + executor: on agent_settled, if this session's pending count
//   reaches the configured bar, inject the rendered light-loop protocol as
//   a follow-up message - the same free-rider pattern as the Claude Code
//   Stop hook. A re-entry flag keeps the evaluation turn from re-triggering;
//   the evaluation clearing pending is the durable guard.
//
// Verification status: written against pi's published extension API
// (references: pi.dev/docs/latest/extensions); not yet validated against a
// live pi install - field reports welcome. Fails closed: any error is
// swallowed and pi is never blocked.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const ROOT = process.env.LAMARCK_HOME ?? path.join(os.homedir(), ".claude", "skills", "lamarck");
const DATA = path.join(ROOT, "data");
// [/\\]+ because the haystack is JSON.stringify output, where one Windows
// backslash arrives as the two characters \\.
const SKILL_RE = /[/\\]+([A-Za-z0-9._-]+)[/\\]+SKILL\.md/;

// One synthetic session id per pi process: pi's extension context does not
// expose a stable session file path portably, and the id only needs to
// group this session's entries and survive until they are evaluated.
const SESSION = `pi-${Date.now().toString(36)}-${process.pid}`;

function logErr(e: unknown): void {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(path.join(DATA, "hook-errors.log"),
      `${new Date().toISOString()} pi-adapter: ${e instanceof Error ? e.message : String(e)}\n`, "utf8");
  } catch { /* diagnostics must never break the harness */ }
}

function offSwitch(): boolean {
  try { return fs.existsSync(path.join(ROOT, "off")); } catch { return true; }
}

function readConfig(): { mode: string; threshold: number } {
  let mode = "threshold", threshold = 5;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    if (["every", "manual", "threshold"].includes(cfg.mode)) mode = cfg.mode;
    const t = Number(cfg.threshold);
    if (Number.isInteger(t) && t >= 1) threshold = t;
  } catch { /* defaults */ }
  return { mode, threshold };
}

function renderProtocol(mineCount: number, names: string[], backlog: number, needed: number, mode: string): string | null {
  let proto: string;
  try { proto = fs.readFileSync(path.join(ROOT, "protocol", "light-loop.md"), "utf8"); }
  catch (e) { logErr(new Error(`light-loop protocol unreadable: ${e instanceof Error ? e.message : e}`)); return null; }
  const backlogClause = backlog >= needed
    ? ` NOTE: ${backlog} pending entr${backlog === 1 ? "y" : "ies"} from other sessions are also on file and are NOT evaluated here; tell the user once that '/lamarck' drains that backlog and that transcript pointers decay after ~30 days.`
    : "";
  const body = proto.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim().replace("{{BACKLOG}}", backlogClause);
  if (!body || body.includes("{{") || body.includes("<!--")) { logErr(new Error("light-loop protocol empty, unfilled or unclosed-comment")); return null; }
  return `lamarck LIGHT loop (trigger: mode=${mode}, needed=${needed}): ${mineCount} skill invocation(s) from this session (session_id=${SESSION}) await evaluation: [${names.join(", ")}]. ` +
    `Working directory: ${ROOT} - every relative path below resolves against it. ` + body;
}

export default function (pi: ExtensionAPI) {
  let injecting = false; // re-entry guard for the evaluation turn

  pi.on("tool_call", async (event: any) => {
    try {
      if (offSwitch()) return;
      const m = SKILL_RE.exec(JSON.stringify(event?.input ?? ""));
      if (!m || m[1] === "lamarck") return;
      let args = String(event?.input?.path ?? event?.input?.file_path ?? "");
      if (args.length > 200) args = args.slice(0, 200);
      let ver = "";
      try {
        const full = JSON.stringify(event.input).match(/"([^"]*[/\\][A-Za-z0-9._-]+[/\\]SKILL\.md)"/);
        const p = full ? full[1].replace(/\\\\/g, "\\") : "";
        if (p && fs.existsSync(p)) ver = crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex").slice(0, 8);
      } catch { /* stamp is best-effort */ }
      fs.mkdirSync(DATA, { recursive: true });
      fs.appendFileSync(path.join(DATA, "pending.jsonl"), JSON.stringify({
        ts: new Date().toISOString().slice(0, 19) + "Z",
        session: SESSION,
        skill: m[1],
        args: `pi:${String(event?.toolName ?? "")} ${args}`.trim().slice(0, 200),
        ver,
        transcript: "" // pi session file path is not portably exposed; channel B falls back to archive
      }) + "\n", "utf8");
    } catch (e) { logErr(e); }
  });

  pi.on("agent_settled", async (_event: any, _ctx: any) => {
    try {
      if (offSwitch()) return;
      if (injecting) { injecting = false; return; } // evaluation turn settled
      const { mode, threshold } = readConfig();
      if (mode === "manual") return;
      const pendingPath = path.join(DATA, "pending.jsonl");
      if (!fs.existsSync(pendingPath)) return;
      const lines = fs.readFileSync(pendingPath, "utf8").split("\n").filter(l => l.trim());
      const mine: any[] = [];
      let backlog = 0;
      for (const l of lines) {
        try { const o = JSON.parse(l); if (!o) continue; if (o.session === SESSION) mine.push(o); else backlog++; } catch { /* tolerate */ }
      }
      const needed = mode === "every" ? 1 : threshold;
      if (mine.length < needed) return;
      const reason = renderProtocol(mine.length, [...new Set(mine.map(o => o.skill))] as string[], backlog, needed, mode);
      if (!reason) return;
      injecting = true;
      pi.sendMessage(
        { customType: "lamarck-light-loop", content: reason, display: true },
        { deliverAs: "followUp", triggerTurn: true }
      );
    } catch (e) { logErr(e); }
  });
}
