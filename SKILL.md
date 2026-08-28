---
name: lamarck
description: Lamarckian skill evolution - traits acquired through real use are inherited back into the skill file. A PostToolUse hook logs every skill invocation; a Stop hook runs a light evaluation loop whose protocol is embedded in the hook reason, so this SKILL.md is not reloaded every turn. Per-skill dynamic rubrics (git-versioned) define what "good" means for each skill and evolve with it. Trigger timing is user-configurable in config.json (every turn / manual only / threshold batch). Read this file only when escalating - when a skill accumulates enough same-type evidence to propose an edit, or on manual invocation. Use when the stop hook says to escalate, or when asked to review skill performance, optimize or improve a skill, audit the skill ledger, distill skill learnings, or switch the lamarck trigger mode.
license: MIT
metadata:
  author: kian
  version: "4.0"
compatibility: Requires the paired PostToolUse/Stop hooks in ~/.claude/settings.json, pwsh, and git
---

# lamarck:用进废退的 skill 进化

拉马克式进化:skill 在**真实使用**中获得的经验,写回它的"基因"(SKILL.md);
衡量它的**尺子(rubric)也随之进化**。(对照 darwin-skill 的达尔文式:合成测试 +
固定考纲 + 评委选择;本 skill 的信号源是生产使用。)三层机制,重活分级触发:

- **记账**(自动,每次 Skill 调用,所有模式下都开):PostToolUse hook 写 `data/pending.jsonl`。
- **轻循环**(回合末,**不加载本文件**):Stop hook 的 reason 内嵌迷你协议——
  四维评估落 `data/ledger.jsonl`、经验沉淀进 `data/learnings/<skill>.md`、清本会话 pending。
  **触发时机由 `config.json` 决定**:`{"mode":"every|manual|threshold","threshold":N}`——
  `every` 每个用过 skill 的回合末触发;`manual` 从不自动触发;`threshold`(默认,N=5)
  攒到 N 条才批量评估。
- **升级**(条件触发,才加载本文件):某 skill 已有 **≥2 次独立调用、同类 gap**
  → 走优化门;或手动 `/lamarck`。

## 尺子:逐 skill 动态 rubric

`data/rubrics/<skill>.md`,格式与规则见 `data/rubrics/README.md`。要点:

- **行为标准从证据结晶**:用户纠正一次即可入册(n=1;rubric 只是评估视角);
  每条必须带 ledger 出处与场景标签,无出处禁止写入;淘汰进 attic 不删除。
- **三处使用**:①四维评估判 gaps 时对照该 skill 的 rubric;②成对盲评的比较标准;
  ③验证 rollout 的"变差与否"判据。评估时只启用场景匹配的条目。
- **git 版本化**:本目录即 git 仓库,rubric 与 skill 协议同库提交,可 diff 可回滚;
  遥测(pending/ledger/learnings)被 .gitignore 排除,仅本地留存。

## 升级后:优化门(SkillOpt 验证门的文本版)

对某个 skill 提出编辑,必须同时满足:

- **证据 ≥2**:ledger/learnings 中该 skill 有 ≥2 次**独立调用**出现同类 gap
  (单次观察永不触发编辑,n=1 是噪声)。
- **提案具体**:能写成 add / delete / replace 的定点操作,写明预期改善与验证方式。
- **不在拒绝缓冲**:`data/rejected.md` 否过的同类提案不得重提,除非有新类型证据。
- **未被冻结**:该 skill 上一次编辑的验证 rollout 尚未完成时,禁止新提案。

门过了 → **用户在环**:用 AskUserQuestion 给用户选(附证据摘要与 diff 要点):

1. **现在就改**(推荐时说明理由)
2. **只留提案** → 写 `suggestions/<skill>.md`,不动文件
3. **否决** → 连原因写入 `data/rejected.md`

非交互会话(用户不在场)一律选 2,并在最终输出里提示用户有待决提案。

用户选 1 后,按归属施工:

- **用户自有 skill**(`~/.claude/skills/<name>/`,非 `synced/`):目标目录在 git
  仓库内 → 编辑前后各 commit 一次(`lamarck: optimize <skill>: <摘要>`);
  否则先复制 `SKILL.md` 为 `SKILL.md.bak`。有界编辑(一次 ≤3 处、单处 ≤10 行,
  禁止整文件重写);`CHANGELOG.md` 记一行:日期、目标、改动、依据证据。
- **插件 / marketplace / synced skill**:永不改原件,只走选项 2。

**验证 rollout(成对盲评)**:被编辑 skill 的下一次被评估调用即验证。派一个
**新的独立 subagent**,同时给它:旧版全文(git 上一 commit 或 `.bak`)、新版全文、
该次调用的真实执行痕迹、该 skill 的 rubric——同一上下文内成对比较出 better /
worse / tie(绝对打分跨会话有校准噪声,成对比较可抵消)。worse → 回滚
(git revert 或恢复 `.bak`),提案连失败原因写入 `data/rejected.md`;
better / tie → 保留,解除冻结。

## 自我优化(仅在升级或手动运行时)

用同一套规则评估本协议自身(假阳性提案?门太松/太紧?轻循环是否顺畅?),meta
观察以 `"skill":"lamarck"` 记 ledger。对本 SKILL.md 或 hook 脚本的任何编辑,
除过优化门外,**必须经用户明确批准**;协议与脚本改动一律 commit 进本仓库。

## Iron Rules(本节修改需用户明确批准)

1. 单次观察永不触发编辑,只记账与沉淀(rubric 入册除外,n=1 可)。
2. 任何 skill 编辑施工前必须让用户选择(AskUserQuestion);非交互会话只落提案。
3. 每次编辑必须可回滚(git commit 或 `.bak`),且写入 CHANGELOG。
4. 永不编辑插件 / marketplace / synced skill 的文件。
5. 永不删除 ledger 历史、learnings 既有观察与 rubric attic。
6. 每次编辑 ≤3 处、单处 ≤10 行,禁止整文件重写。
7. `rejected.md` 中的提案不得重提,除非出现新类型证据。
8. 评估只引用真实可见的执行痕迹;不可见就归档(outcome=archived),不编造。
9. rubric 条目必须带 ledger 出处;验证 rollout 未完成前,该 skill 冻结新提案。

## 手动 `/lamarck`

- 无参数 — 处理全部 pending(本会话条目四维评估;历史会话条目按 skill 聚合归档,
  `{"outcome":"archived","note":"N 次调用,args 样本"}`)+ 沉淀 learnings/rubric + 过优化门。
- `audit <skill>` — 汇总该 skill 全部证据,产出编辑提案(仍走优化门+用户在环)。
- `stats` — 只看账:各 skill 调用频次、corrected 率、gap 排行。
- `mode <every|manual|threshold> [N]` — 改写 `config.json` 切换触发模式(threshold 可带
  阈值 N,缺省 5),改完复述当前配置。config.json 缺失或损坏时脚本回退 threshold/5。

## 数据文件

`data/pending.jsonl`(待处理)· `data/ledger.jsonl`(账本,格式
`{"ts","session","skill","trigger_fit","gaps","outcome","friction","note"}`)·
`data/learnings/<skill>.md`(逐 skill 经验)· `data/rubrics/<skill>.md`(逐 skill 尺子,
git 版本化)· `data/rejected.md`(拒绝缓冲)· `suggestions/<skill>.md`(待决提案)·
`CHANGELOG.md`(编辑留痕)。停用整套机制:本目录创建名为 `off` 的文件。
