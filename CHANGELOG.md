# lamarck 编辑记录(曾用名 skill-optimizer → whetstone)

每次对任何 skill(含本 skill)的编辑都在此记一行:
`日期 | 目标 skill | 改动摘要 | 依据的 ledger 证据(条数/要点) | 验证结果(待验证/通过/已回滚)`

- 2026-08-28 | (初始) | skill-optimizer v1.0 创建,含 PostToolUse/Stop hook 与评估协议 | — | —
- 2026-08-28 | (自身) | v2.0:改名 whetstone;移除 Stop hook 自动触发,评估改手动;新增 data/learnings/ 经验沉淀层 | 用户直接反馈("自己不用自动触发,但是需要积累经验") | 已被 v3.0 修正
- 2026-08-28 | (自身) | v3.0:恢复 Stop hook 自动触发,但迷你协议内嵌 hook reason,SKILL.md 不再每回合重载;仅当某 skill 攒到 ≥2 同类 gap 才升级加载全文;任何编辑施工前 AskUserQuestion 让用户选(改/留提案/否决),whetstone 自身改动必须用户批准 | 用户澄清("自动触发最好;skill 本身不用每次重载;大变化才重载且提示用户/让用户选择") | 通过
- 2026-08-28 | (自身) | v3.1:触发时机三档可配 config.json {mode: every/manual/threshold, threshold: N};用户选定默认 threshold/5;新增 /whetstone mode 切换命令;配置缺失/损坏回退 threshold/5 | 用户需求("加载时机可以用户选择")+ AskUserQuestion 选定 threshold | 通过
- 2026-08-28 | (自身) | v3.2:改名 lamarck(whetstone 撞名 iamakbarsha1/whetstone、iliaal/whetstone;拉马克"用进废退"恰好对照 darwin-skill 的选择式进化);机制无变化 | 用户要求查重改名 + AskUserQuestion 选定 | 通过
- 2026-08-28 | (自身) | v4.4:发布卫生 review 抓出两问题——①config.json 含个人白名单却被当仓库默认发布:untrack + .gitignore,新增 config.example.json 通用模板,config 缺失时 evolution 一律 observe;②README 无安装说明:补 Install 五步(clone/复制配置/hook 接线 JSON/selftest 验证/off 开关);selftest 增至 39 项(example 校验、本地 config untracked、本地 config 合法性) | 全局"三轮零发现"验收第一轮 review 发现 | 通过
- 2026-08-28 | (自身) | v4.3:可证明性——①verify 结论(replay/盲评/分窗)必须落账 ledger(type:verify),report 战绩由此汇总②scripts/selftest.ps1 机制自证:37 项检查,沙箱隔离(%TEMP% 仿真 skills 布局),零接触真实遥测,CI 可跑,首跑 37/37③README Evidence 三层证据策略(机制自证/生产遥测/案例),明确拒绝 darwin 式自评分数 | 用户决定开源+要证明 | 通过
- 2026-08-28 | (自身) | v4.2:二轮借鉴+赛道声明——①废退:净增长预算(>500 行或连续净增 >10% 必附删减案)+ 零引用 rubric/误导段落主动修剪提案(源自 SkillOpt 紧凑性,补上拉马克"废退"半边)②replay 验证:corrected/failed 调用蒸馏为 data/replays/ 回归用例,编辑后先重放再等自然验证(优于 darwin 手编 test prompts)③盲评 tie/分歧才升 3 评委多数票④提案必须全证据合成(SkillOpt mini-batch)⑤/lamarck report 叙事卡⑥README.md(含三家赛道对照表) | 用户指示("可借鉴的都借鉴,做得比他们好,不同赛道") | 通过
- 2026-08-28 | (自身) | v4.1:①进化白名单 config.json evolution 块(evolve/suggest/observe,默认 observe,新装 skill 落 default;初始白名单 seo-cron-ops+lamarck)②记账加 ver 基因版本戳(目标 SKILL.md 内容哈希 8 位)③按版本分窗健康度对比,编辑后变差自动出回滚提案④/lamarck evolve 管理命令⑤存储决定:JSONL 不上 sqlite,量级到再迁 | 用户需求(防负优化+白名单)+ AskUserQuestion 定 observe 默认与初始名单 | 通过
- 2026-08-28 | (自身) | v4.0:借鉴 darwin-skill 四件——①本目录 git 化(遥测 .gitignore,rubric 纳入版本控制)②验证 rollout 改成对盲评(新 subagent 同上下文比新旧版+真实痕迹+rubric)③逐 skill 动态 rubric(data/rubrics/,n=1 入册、带出处、attic 不删)④编辑后冻结该 skill 新提案直到验证完成;远程仓库 github.com/newdee/lamarck-skill(private,暂不推送) | 用户逐条确认(borrow 清单+rubric 动态化+rubric 进 git+建仓) | 通过
