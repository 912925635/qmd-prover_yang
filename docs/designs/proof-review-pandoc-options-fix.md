# Pandoc 选项传递的最小修复

基线：`ee44cf00c3a2527ef1d9cbf80105a1bd8f7983cf`。本轮使用本地独立分支 `fix/proof-review-pandoc-options`，不覆盖 `proof-review-v1-review-r1` 标签，不做远程写入。

## 源码核实

- `skills/qmd-prover/src/core/graph/verify.ts:verifyFacts` 有可选第三参，原类型为 `SelectionOptions`；函数的新鲜度检查实际调用 `compileProject(root, { ...options, write: false })`，会消费 `CompilerOptions`。
- `tests/staleness-guard.test.ts` 初次 compileProject 使用 `options.pandoc` 指定模拟解析器，原来的两次 verifyFacts 调用却没有传入同一 options，导致新鲜度复查回退到环境/配置/系统解析器。
- `skills/qmd-prover/src/core/infrastructure/config.ts:pandocCommand` 的优先级为显式 override → QMD_PROVER_PANDOC → 配置 → PATH 上 pandoc。
- 基线未提供显式解析器时，不存在的回退命令使当前编译结果无法匹配初始签名，受控负对照重现 `SOURCE_STALE`，状态投影没有写入 verified。没有修改安全检查来接受该结果。

这解释了本次用户报告的失败；不能据此推断历史 CI 的所有失败原因，也不能归因于 Node 20。本轮没有读取用户服务器上的原始日志文件；依据 GitHub 固定版本源码以及当前环境的独立复现核实。

## 修改范围

1. 将 verifyFacts 第三参类型补为 `CompilerOptions & SelectionOptions`，对应函数已存在的实际参数消费。没有新增状态分支、改变新鲜度判断或放宽写入条件。
2. 恢复两次测试调用传递同一个 `options`，不使用类型断言或禁用 typecheck 来绕过参数契约。
3. 加固原有投影测试：将 `QMD_PROVER_PANDOC` 临时指向项目内不存在的回退路径；显式模拟解析器应覆盖它。finally 恢复原环境。这样系统 Pandoc 的安装状态无法掩盖丢参。
4. 保留正常 verified 投影断言与并发编辑逐字节保留断言；没有 skip 或放宽断言，没有增加测试计数。
5. 对原 r1 复核文档中“多余第三参、两参签名”的错误判断添加明确勘误；旧标签及其历史源码摘要不变。

## 验证证据

当前执行环境：Linux、Node v24.19.0，区别于用户报告的 Node v24.21.0。使用模拟 verifier，无真实模型调用。

- 修复前，在禁用系统 Pandoc 回退的受控环境，原投影断言实际失败；失败输出保留为 `before-fix.log`。
- 额外负对照：环境回退路径不存在，显式初次编译成功，但故意不向 verifyFacts 传 options，重现 SOURCE_STALE 和缺失的 verified 投影（`negative-control.log`）。
- 最终回归测试在同样不存在的环境回退路径下运行，必须使用显式 parser。三项 staleness 测试全部通过（`staleness-regression.log`），包括真实运行中修改的 SOURCE_STALE 检测。
- 最终全套与静态检查结果将在本记录下方保存。中间采用 PATH 隔离的初稿全套执行已停止，未将其计作最终通过；最终源码版本单独执行，首次失败日志未覆盖。

Windows Job Object 本轮未验证；真实模型数学检错评测未完成。Shadow 的 outcome=inconclusive 及正式 verified/rejected 的边界未改变。

## 固定源码证据

下列 Git blob 摘要可用 git hash-object 核对；正式编译产物摘要与基线相同。

| 文件 | Git blob SHA-1 |
| --- | --- |
| `skills/qmd-prover/src/core/graph/verify.ts` | `496cbf9d81cf52f4dd224be1f4f092d907b4aba4` |
| `tests/staleness-guard.test.ts` | `5e4b4997f240544b661623fd27cc86e065c52a1c` |
| `skills/qmd-prover/scripts/core/graph/verify.js` | `5dbb8d77b67eeafd3bdd7c426b3443535c545c78` |

## 最终检查结果

| 检查 | 实际结果 |
| --- | --- |
| 原投影断言受控复现 | 失败（退出 1，保留首次日志） |
| 故意丢参的负对照 | 重现 SOURCE_STALE、未写 verified；对照断言通过（退出 0） |
| 最终 staleness 回归 | 3/3，通过（退出 0） |
| 最终源码 npm test | 127/127，失败 0、取消 0、跳过 0；退出 0，252363.398815 ms |
| npm run typecheck | 通过，退出 0 |
| git diff --check | 通过，退出 0 |
| git diff --exit-code -- skills/qmd-prover/scripts | 无差异，退出 0 |
| 正式运行产物 | 43 个文件逐一匹配 ee44cf0 基线的 Git blob |

首次失败、负对照和最终执行分别保存，不以通过日志覆盖失败证据。本轮没有新增测试案例，总数仍为 127；加固的是原有测试的环境独立性。本地提交及补丁仅供复核，没有远程写入。

最终全套日志 SHA-256：`305ff105118cf6a3c74851779914f580c6c445ff2f4049b2d964a614beadf44c`。
