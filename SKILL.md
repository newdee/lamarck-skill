---
name: lamarck
description: Lamarckian skill evolution - traits acquired through real use are inherited back into the skill file. A PostToolUse hook logs every skill invocation (stamped with the target skill's genome hash for per-version regression detection); a Stop hook runs a light evaluation loop whose protocol is embedded in the hook reason, so this SKILL.md is not reloaded every turn. Per-skill dynamic rubrics (git-versioned) define what "good" means for each skill; an evolution whitelist in config.json controls which skills may be edited (evolve/suggest/observe, default observe). Read this file only when escalating - when a skill accumulates enough same-type evidence to propose an edit, or on manual invocation. Use when the stop hook says to escalate, or when asked to review skill performance, optimize or improve a skill, audit the skill ledger, distill skill learnings, manage the evolution whitelist, or switch the lamarck trigger mode.
license: MIT
metadata:
  author: kian
  version: "5.0"
compatibility: Requires the paired PostToolUse/Stop hooks in ~/.claude/settings.json, Node.js 18+, and git; cross-platform (Windows / macOS / Linux)
---

# lamarck:用进废退的 skill 进化

拉马克式进化:skill 在**真实使用**中获得的经验,写回它的"基因"(SKILL.md);
衡量它的**尺子(rubric)也随之进化**;长期无用的部分**废退**(修剪)。
赛道:SkillOpt 是训练场(基准分数驱动),darwin-skill 是考场(合成测试+评委),
lamarck 是生活——生产遥测驱动,用进 + 废退双向。三层机制,重活分级触发:

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

## 进化分级(白名单)与防负优化

`config.json`(本地文件,不入库;首次使用从 `config.example.json` 复制)的
`evolution` 块决定每个 skill 的进化等级(显式列表 > `default`;新装 skill 自动
落入 `default`,默认 `observe`)。**config.json 缺失时:一律 `observe`,提示用户
创建**:

- **evolve**(白名单,当前:seo-cron-ops、lamarck):过门提案可走用户三选一直接施工。
- **suggest**:过门提案只写 `suggestions/<skill>.md`,永不直接编辑。
- **observe**(默认):只记账、沉淀 learnings、长 rubric,**不产生任何提案**;
  证据照积,升级到 evolve 后历史证据立即可用。
- 插件 / marketplace / synced skill:无论配置如何,永不直接编辑(上限 suggest)。

**动态评分防负优化**:每条账本带 `ver`(调用时目标 SKILL.md 的内容哈希 8 位)。
升级或 `audit` 时按 `ver` 分窗计算该 skill 的健康度(corrected+failed 占比、gap 频率):
编辑后版本窗口(样本 ≥3)比编辑前变差 → 判定负优化,自动产出**回滚提案**
(仍走用户三选一)。这是成对盲评(单次、即时)之外的第二道统计防线(多次、滞后)。

## 成熟度:收敛的 skill 降为抽查

不是每次评估都有收益——场景不变时 skill 会收敛。每 skill 两态,存
`data/maturity.json`(`{"<skill>":{"state":"active|stable","clean_streak":N,"ver":"..."}}`,
评估时顺手维护):

- **active**(默认):每条 pending 全量四维评估。
- **stable**(进入条件:连续 `stability.streak` 次评估干净——无 gap、无
  corrected/failed、rubric 无新增;默认 10):每条只做一眼扫描(本回合有无用户
  纠正或异常),没有就记一行 `{"outcome":"stable-skip","ver":"..."}`(带 ver,
  版本分窗统计不断粮)并 streak++;**每第 `stability.sample` 条仍做全量评估**
  (默认 5,抽样防漂移);rubric 冻结,不再新增条目。
- **唤醒回 active(任一即触发,立即)**:用户纠正或 failed;抽样评估发现 gap;
  **ver 变化**(被编辑或外部改动——编辑后的验证期必须全量);args 呈现 rubric
  场景标签覆盖不了的新场景(场景变了,收敛前提失效)。
- **收敛即证书**:`report` 把 stable 状态与清白连击数当 Tier 2 证据呈现
  ("该 skill 近 N 次真实调用零纠正")。stable + 长期零引用条目 = 废退修剪的
  天然候选。

`stability` 配置在 `config.json`(缺失回退 streak=10, sample=5)。

## 升级后:优化门(SkillOpt 验证门的文本版)

对某个 skill 提出编辑,必须同时满足(**且该 skill 进化等级为 evolve 或 suggest**):

- **证据 ≥2**:ledger/learnings 中该 skill 有 ≥2 次**独立调用**出现同类 gap
  (单次观察永不触发编辑,n=1 是噪声)。
- **全证据合成**:提案生成时必须综合该 skill 的**全部**在案证据(ledger、learnings、
  rubric),不只触发门槛的那两条(SkillOpt 的 mini-batch 思路)。
- **提案具体**:能写成 add / delete / replace 的定点操作,写明预期改善与验证方式。
- **净增长预算(废退)**:提案给出净行数变化;若使 SKILL.md 超 500 行,或连续两次
  提案净增 >10%,必须同时附删减案。删除类提案是一等公民:长期(≥90 天)零引用的
  rubric 条目、被 gap 证据标记为"误导/从未用到"的段落,主动产出修剪提案(同样走
  用户三选一;修剪内容进 attic / git 历史,不物理消失)。
- **场景围栏(防震荡)**:证据全部来自单一场景标签的提案,只能做**场景分支式
  增量**——新增"当 <场景> 时……"的条件段,不得改写共享核心;改写共享核心需要
  **≥2 个不同场景**的证据。B 场景的优化因此伤不到 A 场景依赖的部分,切回来
  不会退化。
- **全场景 replay**:任何编辑的 replay 验证必须包含**其他场景**的既有用例,
  不只触发场景——replay 语料就是全部历史场景的记忆,"切回旧场景"在施工前就被
  预演过。
- **反震荡检测**:提案若实质推翻 CHANGELOG/git 近期(最近 10 次)已接受的编辑,
  判定为震荡:禁止直接覆写,强制转为场景分支提案,并附两个场景的证据对照交
  用户决策。
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

**编辑后立即 replay 验证**(先于自然验证):从 `data/replays/<skill>.jsonl` 取该
skill 的回归用例(见下),派新 subagent 分别按旧版与新版执行,按 rubric 成对比较。
新版更差 → 直接回滚,不必等下一次真实调用。replay 用例的来源是**真实调用痕迹**:
轻循环评估时,把 corrected / failed 及其他有代表性的调用蒸馏成用例
`{"essence":"任务要点","expect":"按 rubric 的达标要求","src":"ledger ts"}`——
真实分布、零人工编写(darwin 的 test prompts 是手编合成的,此处严格更优)。

**验证 rollout(成对盲评)**:被编辑 skill 的下一次被评估调用即自然验证。派一个
**新的独立 subagent**,同时给它:旧版全文(git 上一 commit 或 `.bak`)、新版全文、
该次调用的真实执行痕迹、该 skill 的 rubric——同一上下文内成对比较出 better /
worse / tie(绝对打分跨会话有校准噪声,成对比较可抵消)。**tie 或与 replay 结论
分歧时,加派 2 个独立评委成多数票**(N=3;平时单评委省成本,难判时才升员)。
worse → 回滚(git revert 或恢复 `.bak`),提案连失败原因写入 `data/rejected.md`;
better / tie → 保留,解除冻结。

**回滚语义(按证据强度分级)**:回滚 = 恢复用户已批准的上一基线,**不算新编辑**,
不受"三选一"与有界编辑约束(Iron Rule 2/6 豁免)——但必须落账并在下次输出中
显式告知用户。分级:replay / 盲评是同输入直接对照(强证据)→ **自动回滚**;
版本分窗是观察性统计(弱证据,可能混杂任务漂移)→ 只出**回滚提案**,走三选一。

**结论必须落账(可证明性)**:replay、盲评、版本分窗三种验证各记一行 verify 记录
进 ledger:`{"ts","skill","type":"verify","stage":"replay|judge|window","old_ver",
"new_ver","result":"better|worse|tie","decision":"keep|revert","judges":N,"detail":""}`。
`judges` 记本次动用的评委 agent 数(成本记账:report 可算"每有效编辑评委调用数",
与 darwin 固定 3 评委×3 轮对比)。`report` 的进化战绩全部由这些记录汇总——
没有落账的效果等于没有效果。

## 自我优化(仅在升级或手动运行时)

用同一套规则评估本协议自身(假阳性提案?门太松/太紧?轻循环是否顺畅?),meta
观察以 `"skill":"lamarck"` 记 ledger。对本 SKILL.md 或 hook 脚本的任何编辑,
除过优化门外,**必须经用户明确批准**;协议与脚本改动一律 commit 进本仓库。

## Iron Rules(本节修改需用户明确批准)

1. 单次观察永不触发编辑,只记账与沉淀(rubric 入册除外,n=1 可)。
2. 任何 skill 编辑施工前必须让用户选择(AskUserQuestion);非交互会话只落提案。
   例外:恢复用户已批准基线的自动回滚(强证据触发),须落账并告知。
3. 每次编辑必须可回滚(git commit 或 `.bak`),且写入 CHANGELOG。回滚本身同样记 CHANGELOG。
4. 永不编辑插件 / marketplace / synced skill 的文件。
5. 永不删除 ledger 历史、learnings 既有观察与 rubric attic。
6. 每次编辑 ≤3 处、单处 ≤10 行,禁止整文件重写。
7. `rejected.md` 中的提案不得重提,除非出现新类型证据。
8. 评估只引用真实可见的执行痕迹;不可见就归档(outcome=archived),不编造。
9. rubric 条目必须带 ledger 出处;验证 rollout 未完成前,该 skill 冻结新提案。
10. 单场景证据不得改写共享核心(只许场景分支式增量);推翻近期已接受编辑的提案
    必须转为场景分支并经用户决策,禁止覆写式打摆子。

## 手动 `/lamarck`

- 无参数 — 处理全部 pending + 沉淀 learnings/rubric + 过优化门。本会话条目做
  四维评估;**历史会话条目先试 transcript 指针**:记录的 `transcript` 路径若仍
  存在(30 天清理期内),Read 其中该次调用附近的片段(按 ts 与 skill 名定位,
  只取所需切片,不整读),据真实执行痕迹做四维评估,并抽客观 friction(工具调用
  数、报错/重试次数、耗时);指针失效或定位不到,才退回按 skill 聚合归档
  `{"outcome":"archived","note":"N 次调用,args 样本"}`。
- `audit <skill>` — 汇总该 skill 全部证据,产出编辑提案(仍走优化门+用户在环)。
- `stats` — 只看账:各 skill 调用频次、corrected 率、gap 排行。
- `mode <every|manual|threshold> [N]` — 改写 `config.json` 切换触发模式(threshold 可带
  阈值 N,缺省 5),改完复述当前配置。config.json 缺失或损坏时脚本回退 threshold/5。
- `evolve list` — 列出全部 skill 及其进化等级与账面健康度;`evolve add <skill> [evolve|suggest]` /
  `evolve remove <skill>` — 改写 `config.json` 的 evolution 块,改完复述。
- `report [skill]` — 进化叙事卡:各版本(`ver`)健康度趋势、已保留/已回滚的编辑、
  rubric 增删、replay 通过率;不带参数出全局摘要。

## 数据文件

`data/pending.jsonl`(待处理,含 `ver` 基因版本戳与 `transcript` 执行日志指针——
执行日志不自建,指向 Claude Code 自己的会话 transcript,按需读切片)·
`data/ledger.jsonl`(账本,格式
`{"ts","session","skill","ver","trigger_fit","gaps","outcome","friction","note"}`,
评估时把 pending 条目的 `ver` 原样带入)·
`data/learnings/<skill>.md`(逐 skill 经验)· `data/rubrics/<skill>.md`(逐 skill 尺子,
git 版本化)· `data/replays/<skill>.jsonl`(真实调用蒸馏的回归用例,仅本地)·
`data/maturity.json`(逐 skill 成熟度状态,评估时维护)·
`data/rejected.md`(拒绝缓冲)· `suggestions/<skill>.md`(待决提案)·
`CHANGELOG.md`(编辑留痕)。`off` 文件:停用自动 hook(手动调用不受影响)。

存储设计决定:账本用 append-only JSONL 而非 sqlite——当前量级(日十条级)模型直读
zero 依赖;若将来到万行级或需要复杂联查,`data/*.jsonl` 可一键导入 sqlite(本机已有
sqlite3),现在不预建。
