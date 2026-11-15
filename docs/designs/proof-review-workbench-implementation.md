# 证明审查工作台实施与交接记录

日期：2026-11-14。基线：远端 `feature/workbench-p0` 的
`5523eb720a0cb58391df68c39d1360184fae6661`。开发分支：
`feature/workbench-p1-p2`。代码与合成测试提交：`597152a`。仅使用任务绑定的 Linux 云端检出；未读取真实论文或
私有会话库，未调用付费验证器，未使用真实凭据，未推送、合并、建 PR 或发布。

## 已完成阶段

1. **协调与正式运行时。** `inspect`、`init` 和绑定写入接入同一项目所有权；
   `dependency`、`render` 的查询编译不再发布正式快照。owner 保存主机、PID、
   进程启动时间、run ID、token 和心跳。提交核对 token 与新鲜源版本；死 owner
   仅能显式恢复，活 owner、外地主机或无法核验的 owner 会被拒绝。正式 verifier
   使用 POSIX 进程组和打包的 Windows Job Object 源资产；取消、超时与正常退出
   后等待进程流结束。快照按 commit UUID 保存不可变代，journal 记录前代、源指纹
   和输出摘要；`graphs/latest.json` 是读取权威入口。指针已切换的 prepared
   journal 在下次获得所有权时可恢复索引。同步 QMD 投影另行核对源字节并报告
   `projection_issues`。
2. **队列与历史。** `jobs plan` 冻结所选闭包、packet 与 checker contract；
   `jobs run` 在派发前重建并校验它们。默认并发 1，显式最多 3。直接依赖只
   传陈述，局部检查不等待上游证明通过。有效缓存命中零调用，`--recheck`
   新建 sealed attempt 而不改数学 key。每次缓存写入与快照指针切换前重新
   核对源。历史和比较只读，识别新旧 verdict 布局；缺失的旧输入显示 unknown。
   新调用失败时，适用的旧缓存决定仍保留，并单列执行失败。
3. **控制、用量与视图。** 保存 run、task 和事件 JSONL；支持 pause、resume、
   cancel、retry、status、watch。未知已派发任务显示 orphaned，不自动重发；
   全部仍 queued 的 orphaned run 在显式恢复后可重验计划继续。取消等待本机
   清理回执。成本汇总分开已报告 token 与未知用量；金额仅按用户提供的带来源、
   日期、币种和逐模型费率表计算。静态工作台展示源版本、任务执行、提交、
   数学、模型、会话、耗时、用量、重试来源及稿件状态，刷新不调用模型。
4. **T11 恢复闭环（`ff03e3b`）。** 真实子进程在完成 attempt seal 后、缓存提交前
   被 `SIGKILL`；显式恢复同主机死 owner 后，`resume` 校验原 run、冻结计划、
   owner token、源签名、发布代指纹及 seal 内文件摘要，再复用唯一完整的报告。
   恢复运行不重发该 verifier 调用，尚未派发的任务可继续。损坏 seal、源变化、
   发布代变化或未知已派发调用均拒绝自动复用或重发。反向复测还修复了旧 run
   在新 owner 活跃时的状态误判，以及 POSIX 父进程正常退出后未等后代清理
   完成即返回的窗口。

## T1–T15 验收记录

| 场景 | Linux 合成/模拟证据 | 状态 |
| --- | --- | --- |
| T1–T2 | P0 session、cache-key、Codex 事件、额度失败测试 | 通过 |
| T3 | history/compare 与静态 HTML 转义测试；无新增模型调用 | 通过 |
| T4–T5 | P0 TeX、上下文、CRLF、部分覆盖及 AI 失败测试 | 通过 |
| T6 | 新测试逐项检查 1/2/3 并发上限和相同最终数学状态；计划去重 | 通过 |
| T7 | 上游 rejected、下游局部 verified、全局 blocked；packet 无依赖证明/状态 | 通过 |
| T8 | 双 CLI 写入争用、源变化、owner token 更换、prepared journal 恢复；新增 seal 后真实进程退出与恢复 | 部分：仍未逐提交步骤覆盖 cache、journal、snapshot 和 pointer 的崩溃窗口 |
| T9 | 正式 runner 的 POSIX 超时、取消、正常退出后代清理 | Linux 通过；Windows 未跑 |
| T10 | 多模型合成比较、同 key 多次 attempt、输入缺失 unknown | 部分：未做意见回应证据关联或后台多模型历史专用任务 |
| T11 | pause/resume/cancel、orphaned 不自动重发、显式 recover/retry；真实崩溃后复用唯一有效 seal，混合 queued 任务继续 | Linux 合成/模拟通过；Windows 未跑 |
| T12 | 未报告用量、缓存命中、逐模型显式费率与缺价 | 通过 |
| T13 | checkout CLI 和 Linux tarball 安装、运行 mock verifier；包内含 runner 与 C# 资产 | Linux 通过；Windows 打包运行未跑 |
| T14 | 旧命令、旧记录和 P0 完整回归 | 通过 |
| T15 | 普通缓存命中零调用；显式 recheck 新 attempt 且数学 key 不变；失败保留旧结论 | 通过 |

自动测试仅使用合成 QMD、TeX、session 和模拟 verifier。2026-11-14 的
Linux 验收：`npm test` 共 175 项，172 通过、0 失败、3 项仅限 Windows 而跳过；
`npm run typecheck`、`npm run build`、`git diff --check` 均通过。最终
`npm pack` 产物在独立目录安装，包内包含正式 runner 和 Windows Job Object
源资产；安装后的 CLI 使用模拟 verifier 完成 `jobs plan`、`jobs run` 并发布
快照。Windows 当前云环境不可用，不能用 Linux 结果代替 Windows 实机验收。

## 仍需处理的设计门槛

- 在 Windows 实机运行正式 verifier 的 Job Object 取消、超时、正常退出后代
  清理，并分别验证 checkout 与 npm tarball 安装。
- 对 cache、journal、snapshot 和 pointer 的每个崩溃窗口做真实子进程故障
  注入；当前测试以合成 prepared journal 和死 owner 验证恢复分支。
- 未知已派发调用仍维持 fail closed，须先查明结果再显式 retry；重试可能产生
  新的模型费用。已有 seal 只在输入、owner、源和发布代完整核验后复用。
- 增加带回应证据的意见关联和只留历史的后台多模型审查路径。当前比较只列
  字段变化，不把“本轮未再提出”解释为已解决。
- 所有权仅保证同主机本地文件系统。未知或损坏的 owner 不能安全自动恢复，
  网络挂载和跨主机并行写入未获支持。

这些未完成项意味着本分支不能称为 P1/P2 设计全部验收完成，也不能用工作台
运行成功代替数学证明通过。
