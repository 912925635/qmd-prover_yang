# proof-review-v1 本地补丁复核 r1

复核版本标识：`proof-review-v1-review-r1`。本记录与修复代码由同一本地提交和同名 annotated tag 固定；以该 tag 指向的提交为准，避免在文件内自引用提交哈希。

- 审查修复前基线：`b518ebd16c1e2fe6db39796da32dc3d3c9aa4e05`。
- 完整功能 diff 基线：`142e7f86187783951208f128fde51920f269aad5`。
- 方法：逐项阅读修复前后源码、追踪请求/校验/写入调用链、检查指纹输入和重新读取边界，再运行本地验证。本轮没有新增产品行为修改。
- 结论：在以下明确范围内未发现新的阻塞问题，可以固定为下一轮独立审查的本地版本。Windows 实际执行仍是未完成的平台验证，不能据此宣称 Windows 已通过。

## 六项意见的核实与修复证据

下表源码位置均相对仓库根；行号对应本记录的源码摘要。

| 意见 | 原意见结论及原源码依据（b518ebd） | 修复后的机械证据 |
| --- | --- | --- |
| P1 目标作为 premise | 成立。`packet.ts: sources` 包含目标；`decomposition.ts: premises` 只检查锚点合法性和向前引用，没有排除目标。 | `decomposition.ts:56` 对任何 `premise.source === 'target.statement'` 抛错，覆盖完整目标与子串；不委托 Fidelity。 |
| P1 decomposition 退化及最终链 | 成立。原 `readDecomposition` 接受任意非空 obligation 数组，没有最终节点字段；任意节点可用目标作 conclusion，只有向前依赖禁令和全文覆盖。 | `decomposition.ts:40` 检查顺序 ID；`:46` 按非空段落限制 span；`:50` 限制依赖为不同的更早节点；`:60` 要求早期 proof premise 有显式所属边；`:67` 最终节点必须为 inference 且 conclusion 覆盖完整目标；`:77` 最终节点必须为最后节点；`:79` 默认至少两个 inference；`:80` 从最终节点反向遍历，`:87` 拒绝不连通的 inference。 |
| P1 正文重复及大型 argv | 成立。原 `packet.ts:context` 和 `sources` 均持有 proof/statement；原 Anchor 包含 quoted_text；原 `codex-adapter.ts` 将拼成的完整 prompt push 到 argv。 | `packet.ts:86` 的 context 只持 source ID，`:92` 保留 canonical corpus；`decomposition.ts:12` 验证可选旧 quote 后丢弃；`types.ts:2` Anchor 仅 source/start/end；`review.ts:40` 和 `:54` 规范化成功响应；`codex-adapter.ts` 使用 `exec ... -`、`child.stdin.end(prompt)` 和 UTF-8 流解码。 |
| P1 Windows timeout 后残留 CLI | 成立。原 `roles.ts:terminate` 在 Windows 只调用直接 child.kill，代码注释要求 adapter 自行清理后代。 | `process.ts:19` 在 Windows 启动私有 supervisor；`windows-job.ps1:Enter` 先将 supervisor 加入不可 breakaway、KILL_ON_JOB_CLOSE 的 Job，随后才启动 adapter。Job 句柄默认不继承；失败直接退出。`process.ts:28` 的 timeout/cancel 清理杀 supervisor，`:56` 等 close 后返回；POSIX 保留 detached group/SIGKILL 路径。 |
| P2 绝对路径影响 hash | 成立。原 `policy.ts` 将含绝对 command/implementation_files 的 policy 和 `{file: absolutePath, hash}` 直接放进 hash。 | `policy.ts:55` 建立位置保持的 component ID；`:63` 规范化直接路径/file URL；`:71` 身份只含结构、模型、版本和内容；`:91` 排除 policy 中的运行位置；`:94` 得出 hash。同平台同架构的相同安装复制保持身份。 |
| P2 loader/runtime 漏计 | 成立。原示例只声明 adapter 和 CLI，原自动文件集合只含 command[0] 与声明文件，未覆盖 tsx loader/runtime。 | `policy.ts:63` 自动计入直接 argv 文件；`:15` 递归目录内容和排序相对名，拒绝内部符号链接；`:87` 纳入所有本地 Shadow 模块和 PS helper；`:92` 加入平台/架构及 Windows supervisor exe 内容。设计文档示例声明 tsx/esbuild/平台包，包装型 CLI 也要求声明实际实现。 |

## 校验顺序与数学边界

`review.ts:36` 调 decomposer → `:40` readDecomposition → `:48` 才调 Fidelity。结构校验失败时在内层 catch 设置 blocked 并抛出，跳过第二次模型调用。最终锚点要求 source、start=0 和 end=目标全文长度完全一致（`decomposition.ts:19`）。更早节点约束使 DAG 无环，最终反向可达检查覆盖全部声明为 inference 的节点。

这些不变量证明的是来源、覆盖和声明的结构，不能证明数学蕴含：模型仍可能错误地把推理标成 context、声明假依赖、在同一 span 内把结论当假设，或者使用语义上等价于目标的其他文字。Fidelity 明确审查这些语义问题；本轮没有引入数学验证器。目标字段禁令并不声称排除所有语义循环。默认至少两个 inference 与段落限制共同阻止明显单节点退化，没有以字符数作唯一标准。真实单步证明必须由可信 policy 显式设置 `min_inference_obligations: 1`，模型不能自批豁免。

## Shadow 隔离的源码调用链

- `cli.ts:28` 调 reviewRecord，`:30` 仅调 saveReport；没有调用正式 verifier 或状态投影。
- `packet.ts:79` 对依赖采用 statement-only 白名单，不转发上游 proof/status 或原 verdict。
- `review.ts:19` 固定 applicability=recorded-packet-only、current_source_checked=false；`:22` 固定 outcome=inconclusive、coverage.checked=0。Fidelity pass 仅赋予独立 stage_status=ready_for_proof_review（`:56`），不产生 verified/rejected。
- `report.ts:16` 将写入限定到 `.qmd-prover/proof-review`；`:22`/`:23` 写独立 JSON/Markdown，然后目录 rename。没有正式 verdict/graph/source 的写入路径。
- `roles.ts:14`/`:36` 创建及删除临时 cwd。外部 adapter 是可信进程并继承环境；这里没有 OS 级恶意 adapter 文件写入隔离。Codex read-only 模式也不能证明独立数学判断。
- 完整 diff 相对 142e7f8 的 `skills/qmd-prover/src` 和 `skills/qmd-prover/scripts` 均为空；原正式 schema v8、protocol v6、verified/rejected 状态机及缓存契约未变。
- 后续勘误：初审将 `tests/staleness-guard.test.ts` 的第三实参判为多余并删除，这一判断不成立。`verifyFacts` 实际有可选第三参，且内部新鲜度复查会把该参交给编译器；删除 `options` 使测试隐式依赖系统 Pandoc。历史 127/127 是当时环境的结果，不能证明测试没有环境依赖。后续修复和受控复现见 [Pandoc 选项修复记录](proof-review-pandoc-options-fix.md)；本记录的摘要表仍对应原 r1 标签，不代表修复后的 HEAD。

正式实现的 Git tree 身份（与 142e7f8、b518ebd 相同）：

| 目录 | Git tree |
| --- | --- |
| `skills/qmd-prover/src` | `1a52ca42e7dc7df13711bc1de529cc7a4ed57dae` |
| `skills/qmd-prover/scripts` | `ee04185b9d97f3023ab92100de78f05c05bcdf14` |

## 指纹与缓存边界

`policy.ts:41` 的 memo 在每次 loadPolicy 内重新创建，只合并该次读取中重复文件的 hash 工作，没有跨调用缓存。`review.ts:15` 读取初始身份；`:64` 重新读 record 原始字节以及 loadPolicy，对运行中 record/policy/实现漂移降级为 inconclusive（`:68`）。本逻辑不检查历史记录对应的当前 QMD；发生后再恢复的瞬时改动也不构成可检测保证。

hash 输入包括 guard/预算设置、模型、显式实现版本、保持 argv 顺序及路径复用关系的 component ID、文件或目录内容、本地模块，以及 platform/arch。实际运行使用原始路径，路径仍保留在报告 policy 中供审计，但不参与位置身份。目录 manifest 名称相对根且排序；缺失文件/目录、内部符号链接均拒绝。Windows 上 PowerShell 二进制内容也参与身份。

`report.ts:18` 的 packet+policy hash 仅用于命名空间，`:19` 每次 mkdtemp 创建新 run，没有自动缓存命中/复用。这里的“缓存指纹”是未来复用所需的来源身份，不是已实现的证明结果缓存。

该机制不是通用依赖解析器：未声明的动态 import、配置/环境变化、远程模型别名背后变化仍需实现文件声明和 implementation_version 管理。内嵌于不透明字符串的路径不做猜测规范化。平台/架构或运行时内容不同而 hash 不同是预期行为。

## 本地验证与新增回归

环境：Linux，Node v24.19.0。以下检查均在本次固定版本前重新执行，退出码均为 0：

- `npm test`：127 tests，127 pass，0 fail，0 cancelled，0 skipped；124146.382636 ms。
- `npm run typecheck`：通过。
- `git diff --check`：通过；文档加入后、stage 后再检查。
- `git diff --name-only 142e7f86187783951208f128fde51920f269aad5 -- skills/qmd-prover/src skills/qmd-prover/scripts`：空输出。

本次修复相比 b518ebd 新增 16 个 test cases（全套原有 111 → 127）：

| 文件 | 新增行为覆盖 |
| --- | --- |
| `tests/proof-review-shadow.test.ts`（11） | 目标/子串 premise 禁令；单步可信豁免；段落 guard；最终节点/完整目标；inference 可达性；早期 premise 显式边；紧凑 corpus 与审计；跨路径相同身份；loader/runtime 变化身份；多 MiB corpus 单份传递；Codex 多 MiB Unicode stdin。 |
| `tests/proof-review-process.test.ts`（5） | timeout 杀 adapter/model/grandchild；AbortSignal 清理；正常结束清理残留；预取消不启动；大 Unicode stdin 与含空格/引号/反斜杠/空参数 argv。 |

原有独立测试还覆盖正式文件字节不变、真实 engine record、漂移降级、Fidelity 非证明结论。测试使用模拟 CLI，无付费模型调用。Codex stdin 接口已通过本地 codex-cli 0.159.2 exec --help 核对。Windows 分支未在本机执行；`.github/workflows/test.yml` 新增 Windows 专项 job，Windows 本地可运行 `node --import tsx --test tests/proof-review-process.test.ts`。添加 CI 配置不代表 CI 已通过，当前不 push、不创建 PR。

## 源码固定摘要

以下为 Git blob 对象身份，可用 `git hash-object <path>` 核验；涵盖完整功能 diff 和所有本地 Shadow 模块。本记录自身由包含它的提交/tag 固定，避免摘要自引用。用 `git diff 142e7f8 proof-review-v1-review-r1` 查看完整功能 diff，或 `git diff b518ebd proof-review-v1-review-r1` 查看本轮修复。

| 文件 | Git blob SHA-1 |
| --- | --- |
| `.github/workflows/test.yml` | `629063829f78ebf5c4ad7b04a738c5381103e8af` |
| `docs/designs/proof-review-shadow.md` | `cb7cce98f2b5b11503d8e013e74d8fd2c87a29b2` |
| `readme.md` | `a7c75d49e481f6d55edfc50734f705a3e4879bc8` |
| `tests/proof-review-process.test.ts` | `cdfba86852a84d9b68f4bd53cc66febf325d6cb8` |
| `tests/proof-review-shadow.test.ts` | `901c7092ba78e9822ad3376f22bb7424e95ce823` |
| `tests/staleness-guard.test.ts` | `45bd761a034561add9d8a546d94b59c3f5296b6b` |
| `tooling/proof-review/cli.ts` | `d2ffd8ba57e5e9e2ed55254712f0937abd1c266a` |
| `tooling/proof-review/codex-adapter.ts` | `91b90b9cc186667b4a2e62a5c3b18aa530607b3a` |
| `tooling/proof-review/decomposition.ts` | `281f5439f5b97048a2b1a57ef13f6e02760a385c` |
| `tooling/proof-review/faithfulness.ts` | `f2aebab4ccf74193f616978ac4be94ad725ff029` |
| `tooling/proof-review/packet.ts` | `29b6b13833d90d7140d8ece9ada6d2db18b8cfd0` |
| `tooling/proof-review/policy.ts` | `313df1f3b5ac6817515c429a6c7d42c05c7caded` |
| `tooling/proof-review/process.ts` | `ab0433d151c1ff3839141f4bf5d91b8a018f22e7` |
| `tooling/proof-review/prompts.ts` | `0a66891f79f7f09d67e8e1e72340e691640cf5a2` |
| `tooling/proof-review/report.ts` | `1f879b0591355ce6171968052005f09e175d8e2b` |
| `tooling/proof-review/review.ts` | `fbcc662debf6e04c386c929db4f6061c5092a281` |
| `tooling/proof-review/roles.ts` | `f797cea956dc1f5b1844a98567ff30e9b5e13c14` |
| `tooling/proof-review/types.ts` | `032309639b3eca35e28eca588692390fbabee690` |
| `tooling/proof-review/windows-job.ps1` | `8711ebe4af2ae07f833478ad63f8cf734aefd707` |

本次完整测试输出 SHA-256：`0017bab17deb721bd73c4dfffafb08ede7677d23c1ab818fd8bb194968607227`（摘要仅用于核对当次执行日志，不替代上面的源码证据）。
