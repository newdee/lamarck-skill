# lamarck

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/lamarck-skill)](https://www.npmjs.com/package/lamarck-skill)
[![ci](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/newdee/lamarck-skill/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![selftest](https://img.shields.io/badge/selftest-74%2F74-brightgreen)](scripts/selftest.js)

**生产环境的 skill 自进化系统。** 不是给某一个手工圈选的 skill 做一次性
优化:装一次,你的全部已装 skill(几百个也一样)在真实使用中持续积累证据,
满足条件时进化——编辑经你批准落地,或对你显式升到 auto 的 skill 由 replay
把关、事后报告。lamarck 同时在运行中按同一套规则进化自己(自身永不 auto)。
使用中获得的性状写回 skill 文件;长期无用的部分废退(修剪)。每个不可逆动作
都经用户授权、落账、可回滚:**治理是全量进化敢做的前提**。

```
npx lamarck-skill
```

## 赛道对照

| | [SkillOpt](https://github.com/microsoft/SkillOpt) | [darwin-skill](https://github.com/alchaincyf/darwin-skill) | lamarck |
|---|---|---|---|
| 隐喻 | 训练场 | 考场 | 生活 |
| 信号 | 基准分数 | 合成测试 prompt + 评委团 | **生产遥测**:真实调用、真实用户纠正 |
| 触发 | 离线运行 | 手动运行 | hook 观察每次调用,按阈值批量评估 |
| 尺子 | 固定 | 固定 9 维(SkillLens) | **逐 skill、动态、git 版本化**——从证据结晶,随 skill 进化 |
| 回归测试 | 基准 | 手工编写 prompt | **从真实痕迹重放**(零人工编写) |
| 方向 | 改进 | 改进 | 改进**且修剪**(用进废退) |
| 覆盖面 | 每次针对一个基准目标 | 你逐个指定的 skill,各需配测试题 | **全部已装 skill,被动零配置**——逐 skill 治理分级 |

保留了两家的精华:SkillOpt 的验证门、有界编辑与拒绝缓冲;darwin 的 git 回滚、
成对盲评(仅难判时升 3 评委多数票)与人在环检查点。

## 机制

1. **记账**(PostToolUse hook):每次 skill 调用 → `data/pending.jsonl`,
   附目标 skill 的内容哈希(`ver`),供按版本分窗做退化检测。
2. **轻循环**(Stop hook):迷你评估协议内嵌在 hook reason 里——每回合不重载
   SKILL.md。四维 verdict 对照该 skill rubric 中场景匹配的条目判定后落
   `data/ledger.jsonl`;用户纠正 n=1 结晶为一条带出处的 rubric 条目;经验沉淀
   进 `data/learnings/`;回归用例进 `data/replays/`——既收割失败,也收割语料
   尚未覆盖其场景的 clean 调用。触发时机可配:每回合 / 仅手动 / 阈值批量
   (默认 5)。
3. **进化**(门控):≥2 次独立同类 gap → 综合全部证据生成有界编辑提案 →
   用户三选一(现在就改 / 只留提案 / 否决)。编辑后先 replay 重放,下次真实
   调用做成对盲评,版本分窗健康度做统计兜底。任何退化 → 回滚提案。
4. **信任阶梯**:`config.json` 给每个 skill 定级 auto / evolve / suggest /
   observe(默认 observe;插件上限 suggest;新装 skill 继承默认)。`auto` 是
   挣来的自治:过门编辑不问直接落地——replay 重放升为放行条件(不过即时回滚),
   每笔事后报告、落账、一步 `git revert` 可撤。lamarck 自身、Iron Rules 与
   插件无论怎么配都必须显式批准。
5. **收敛**:不是每次迭代都有收益。清白连击(默认 10)后 skill 进入 stable
   ——评估降为抽查(每 5 条抽 1)加一行 `stable-skip` 记录;任何用户纠正、
   基因变化或新场景立即唤醒。长清白连击本身就是证据:report 把它呈现为
   生产可靠性证书。

一切不可逆动作需用户明确确认。遥测永不出机(已 `.gitignore`);rubric 与
代码同库版本化。

## 架构:core + 适配器

core 是 harness 无关的——数据文件、优化门、评估协议
([protocol/light-loop.md](protocol/light-loop.md),单源,逐字注入)没有
任何 Claude 特有内容。harness 通过**适配器**接入,三个角色——collector
(每次调用追加一行 pending)、trigger(决定何时评估)、executor(执行协议
的模型)——契约见
[protocol/adapter-contract.md](protocol/adapter-contract.md)。Claude Code
是随包的参考适配器(`scripts/` 里的两个 hook);pi 是计划中的第二目标
(其 extension 机制三个角色齐备);Codex 今天能承担 collector + trigger,
但无法把协议注入回模型,只能跑 manual 档。

## 证据

诚实政策:**不做自评分数**(优化器用自家评委给自家产出打分证明不了任何事;
darwin 自己引用的 SkillLens 论文说 LLM 自评准确率约 46%)。取而代之的分层:

1. **机制自证** —— `node scripts/selftest.js`,隔离临时沙箱,零接触真实
   遥测。当前 **74/74**:hook 记账、基因戳、三档触发、配置回退、会话隔离、
   防死循环、字节级可复现输出、gitignore 边界,以及轻循环所依赖的协议条款
   活性(rubric 接线、replay 收割、积压提示)。CI 可用(exit code 门控)。
2. **生产遥测**(按设计自动积累):每次调用带目标 skill 基因哈希,每笔被
   接受的编辑都有前后窗口,以**用户纠正率**度量——ground truth 来自用户
   行为,不是模型自评。replay 验证提供受控对照:同一真实输入、新旧基因。
   全部 verify 结论落账;`/lamarck report` 汇总。
3. **mutation-bench**([bench/ 在 GitHub](https://github.com/newdee/lamarck-skill/tree/main/bench),
   协议先预注册再执行):已知真值的受控劣化 + 盲评 A/B。run-001:**已知劣化
   变体拦截 4/5,已知改善变体误拦 0/2**(单评委、三案多数;漏网的那个有公开
   分析,不藏)。原始 verdict 逐字入库。
4. **自应用** —— lamarck 按自己的规则进化:对自身的每次改动都有触发证据、
   有界 diff、用户批准与验证结果。[CHANGELOG.md](CHANGELOG.md) 就是可审计的
   历史,含四个在其记录的 review 纪律下抓出并修复的缺陷。不打分,留痕。
5. **真实案例** —— 从生产使用中积累,发布前公开,观察性局限(任务分布
   漂移)如实声明。

## 安装

一条命令——拷贝 skill、初始化本地配置、把两个 hook 接进
`~/.claude/settings.json`(先备份、只增不删、幂等),装完自动跑 selftest
自证:

```
npx lamarck-skill
```

(等价:`npx github:newdee/lamarck-skill`)。装完重启 Claude Code(或开一次
`/hooks`)让 hook 加载。卸载(摘 hook、保留文件与遥测):
`npx lamarck-skill uninstall`。

手动安装步骤见英文版 [README](README.md#install) 折叠段。停用开关:在 skill
目录创建名为 `off` 的文件(静默两个 hook;手动 `/lamarck` 属显式意图,不受
影响)。

## 装完第一周会发生什么

一开始什么动静都没有——这是设计。hook 静默记录每次 skill 调用;一个会话攒够
5 条(默认阈值),回合末评估把 verdict 写进账本。几天过去,各 skill 的证据慢慢
攒;某个 skill 第一次出现两次同类 gap 时,你会收到三选一提示:采纳编辑、留作
提案、或否决。干净的 skill 会收敛降为抽查。冷启动是真实存在的:第一周没有任何
提案,通常说明你的 skill 都挺健康,不是 lamarck 没干活——看一眼
`data/ledger.jsonl` 就知道它在记。

## 常见问题

- **怎么确认 hook 活着?** 随便用一个 skill,看 `data/pending.jsonl` 是否多了
  一行。意外错误会落在 `data/hook-errors.log`(那里安静 = 健康)。
- **评估时机我能控制吗?** 能:`/lamarck mode every` / `manual` /
  `threshold N` 三档随切,`/lamarck` 随时手动跑。
- **哪些 skill 会被改?** 只有白名单里的(`/lamarck evolve add <skill>`)。
  默认全是 observe:只攒证据,不动文件。插件永远不会被直接编辑。
- **能不能不每次都问我?** 能——把久经考验的 skill 升到 `auto`
  (`/lamarck evolve add <skill> auto`):过门编辑不问直接落地,replay 把关,
  事后报告,一步 `git revert` 可撤。lamarck 自己永远不跑 auto。
- **什么时候需要手动跑 `/lamarck`?** 清算其他会话攒下的积压(积压到够清算时
  轻循环会主动提醒)、`audit <skill>` 做全量证据审查、`stats` 看记分板、
  `report` 看进化叙事。
- **怎么暂停?** 在 skill 目录建一个名为 `off` 的文件(hook 静默;手动调用
  不受影响)。卸载:`npx lamarck-skill uninstall`。
- **为什么一直没有优化建议?** 证据门:每个 skill 要攒出 ≥2 次独立同类 gap
  才会出提案。健康的 skill 永远不会触发——这是特性。

## 环境要求

任意平台的 Claude Code(Windows / macOS / Linux)——Node.js 18+ 与 git。
hook 接在 `~/.claude/settings.json`(PostToolUse 匹配 `Skill`,Stop)。

## 相邻工作

最近的邻居是 [self-improving-skills](https://github.com/UniM0cha/self-improving-skills)
——它也用 PostToolUse hook、也会改 SKILL.md。逐行分界(附
[task-observer](https://github.com/rebelytics/one-skill-to-rule-them-all) 作参照):

| | lamarck | self-improving-skills | task-observer |
|---|---|---|---|
| 触发 | **被评估的结果**:gap 分类、用户纠正作 ground truth | 活动量:距上次蒸馏 N 次工具调用/文件改动 | 手动会话复盘 |
| 覆盖面 | **全部已装 skill,被动观察**(插件上限 suggest);逐 skill auto/evolve/suggest/observe 分级 | 以它自己蒸馏出的 skill 为主 | 你手动复盘到哪算哪 |
| 治理 | 证据门(≥2 次独立同类 gap)+ 每笔编辑用户批准,或逐 skill 挣得的 auto(replay 把关落地) | 后台自动改,写完才校验 | 只出建议,不动手 |
| 验证 | **语义级**:真实痕迹 replay 新旧对照、成对盲评、版本分窗健康度 | 语法级:SKILL.md 写坏才回滚 | 无 |
| 修剪 | 引用型提案(条目 90 天零引用) | 时间型归档(30/90 天没用) | 无 |
| 效果证明 | 预注册基准、跨平台 CI 自测、留痕的自应用 | — | — |

一句话:它问"用得多了,该总结了";lamarck 问"表现如何、证据够不够、改完
真的变好没有"。skill 收割类(self-learning-skills、autoskill)是从会话造
**新** skill,不是进化既有 skill。

## 路线图

两条正交轴,都由适配器契约定形:

- **基因轴**——抽象不限于 skill:任何驾驭 agent、且在生产中被反复使用的
  文本工件,都能在同一套 遥测 → 账本 → 尺子 → 门控编辑 架构下进化。计划
  目标依次:subagent 定义(`.claude/agents/`)、CLAUDE.md / AGENTS.md
  记忆文件、slash command、MCP 工具配置。
- **harness 轴**——core 与 agent 无关(见架构章);pi 适配器是计划中的
  第二个 harness,而 Agent Skills 规范的跨工具采纳意味着同一份 SKILL.md
  基因会在多个 harness 反复出现——共享账本届时能跨 harness 度量同一个
  skill。

Iron Rules 全线通用:证据门、用户在环、回滚、白名单。

## 状态

已发布:`lamarck-skill` 上架 [npm](https://www.npmjs.com/package/lamarck-skill)
与 GitHub。设计日志见 [CHANGELOG.md](CHANGELOG.md)。生产真实案例(证据第 5
层)正随使用积累,完成后在此发布。
