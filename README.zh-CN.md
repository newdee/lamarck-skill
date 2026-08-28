# lamarck

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/lamarck-skill)](https://www.npmjs.com/package/lamarck-skill)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![selftest](https://img.shields.io/badge/selftest-44%2F44-brightgreen)](scripts/selftest.js)

**Claude Code skill 的受治理进化。** lamarck 持续观察每一次真实的 skill
调用,在证据门约束下推动被观察 skill 的进化——并在运行中按同一套规则进化
自己。使用中获得的性状写回 skill 文件;长期无用的部分废退(修剪)。每个不可
逆动作都经用户批准、落账、可回滚:**治理本身就是卖点,不是补丁**。与
[darwin-skill](https://github.com/alchaincyf/darwin-skill) 互为对照。

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

保留了两家的精华:SkillOpt 的验证门、有界编辑与拒绝缓冲;darwin 的 git 回滚、
成对盲评(仅难判时升 3 评委多数票)与人在环检查点。

## 机制

1. **记账**(PostToolUse hook):每次 skill 调用 → `data/pending.jsonl`,
   附目标 skill 的内容哈希(`ver`),供按版本分窗做退化检测。
2. **轻循环**(Stop hook):迷你评估协议内嵌在 hook reason 里——每回合不重载
   SKILL.md。四维 verdict 落 `data/ledger.jsonl`;经验沉淀进 `data/learnings/`;
   corrected/failed 的调用蒸馏为 `data/replays/` 回归用例。触发时机可配:
   每回合 / 仅手动 / 阈值批量(默认 5)。
3. **进化**(门控):≥2 次独立同类 gap → 综合全部证据生成有界编辑提案 →
   用户三选一(现在就改 / 只留提案 / 否决)。编辑后先 replay 重放,下次真实
   调用做成对盲评,版本分窗健康度做统计兜底。任何退化 → 回滚提案。
4. **白名单**:`config.json` 给每个 skill 定级 evolve / suggest / observe
   (默认 observe;插件上限 suggest)。新装 skill 继承默认。
5. **收敛**:不是每次迭代都有收益。清白连击(默认 10)后 skill 进入 stable
   ——评估降为抽查(每 5 条抽 1)加一行 `stable-skip` 记录;任何用户纠正、
   基因变化或新场景立即唤醒。长清白连击本身就是证据:report 把它呈现为
   生产可靠性证书。

一切不可逆动作需用户明确确认。遥测永不出机(已 `.gitignore`);rubric 与
代码同库版本化。

## 证据

诚实政策:**不做自评分数**(优化器用自家评委给自家产出打分证明不了任何事;
darwin 自己引用的 SkillLens 论文说 LLM 自评准确率约 46%)。取而代之的分层:

1. **机制自证** —— `node scripts/selftest.js`,隔离临时沙箱,零接触真实
   遥测。当前 **44/44**:hook 记账、基因戳、三档触发、配置回退、会话隔离、
   防死循环、字节级可复现输出、gitignore 边界。CI 可用(exit code 门控)。
2. **生产遥测**(按设计自动积累):每次调用带目标 skill 基因哈希,每笔被
   接受的编辑都有前后窗口,以**用户纠正率**度量——ground truth 来自用户
   行为,不是模型自评。replay 验证提供受控对照:同一真实输入、新旧基因。
   全部 verify 结论落账;`/lamarck report` 汇总。
3. **mutation-bench**(`bench/`,协议先预注册再执行):已知真值的受控劣化
   + 盲评 A/B。run-001:**已知劣化变体拦截 4/5,已知改善变体误拦 0/2**
   (单评委、三案多数;漏网的那个有分析,不藏——见 `bench/README.md`)。
   原始 verdict 逐字入库。
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

## 环境要求

任意平台的 Claude Code(Windows / macOS / Linux)——Node.js 18+ 与 git。
hook 接在 `~/.claude/settings.json`(PostToolUse 匹配 `Skill`,Stop)。

## 路线图

基因抽象不限于 skill:任何驾驭 agent、且在生产中被反复使用的文本工件,都能
在同一套 遥测 → 账本 → 尺子 → 门控编辑 架构下进化。计划目标依次:subagent
定义(`.claude/agents/`)、CLAUDE.md / AGENTS.md 记忆文件、slash command、
MCP 工具配置。Iron Rules 全线通用:证据门、用户在环、回滚、白名单。

## 状态

已发布:`lamarck-skill` 上架 [npm](https://www.npmjs.com/package/lamarck-skill)
与 GitHub。设计日志见 [CHANGELOG.md](CHANGELOG.md)。生产真实案例(证据第 5
层)正随使用积累,完成后在此发布。
