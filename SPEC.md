# Kent 待审阅事项改进规格说明（Spec）

> **状态（2026-11-26）：以下 S-1 … S-8 均已在代码中实现（S-2 的本机就绪判断在随后的审查中修正）。本文保留为这轮审查的设计记录，不再是待办清单；当前行为以 `README.md` / `RECIPE.md` 为准。**

## 2026-11-26 社区调研 P1 实现记录

这一轮按《Herdr 社区布局调研：Kent 该补的四件事》先落地 P1，不改动既有的跨客户端分组同步模型（CAS、冲突重放、离线队列）：

- **折叠组计数与全局 needs-you。** 折叠组头显示 working 数量（转圈）、红色 `!n` blocked、`●n` done；展开时保持安静。`Spaces` 标题旁显示全局 blocked agent 计数，点一下跳到第一个。数据全部来自 Herdr 的 `space.status` / `agents()`，Kent 不自建 done 已读表。
- **新建落位与关闭回落。** 顶部 New space 使用当前 space 所在分组；组头 `+` 在当前 space 属于同组时传入 `afterId`，创建后插到它下面。关闭当前 space 后，在机器 ready 的前提下选中列表里它上面最近的一行；机器离线/loading 不误判为关闭。
- **过滤与键盘导航。** 搜索按钮、palette **Filter spaces**、`kent.filter` 打开 30px 过滤框；匹配 space 名、机器、repo、branch、folder；组名命中显示整组；`↑`/`↓`/`Enter`/`Esc` 可用。过滤发生在 `ordered()` 之后，过滤子集不会传给 `space.move`。
- **Parked 项目。** 关闭 space 时按机器记录 `{folder, name, group, at}` 到 `kent.projects.v1`（上限 50）；机器列表末尾显示可折叠 Parked 区，点击用 `space.new {folder, name}` 重开，`×` 忘掉；同一 folder 仍开着时不显示，Parked 行不进入 `seen`。此后（issue #4）改为存进机器文档 `kent.groups.v1` 的 `projects`，`kent.projects.v1` 保留为本地副本与迁移源。
- **worktree 树线。** 组内 worktree 行增加绝对定位的竖线/转角线，替代文字树符，保留原有“只有同组内连续相邻才嵌套”的规则。

P2 的 Archive、组色/起始目录、Collect from 规则与 worktree 折叠/未打开 repo 头，以及 P3 的拖拽阈值/抬升动画，本轮未并入；`README.md` 的 Notes 记录了当前边界。

## 优先级总览

| 编号 | 主题 | 优先级 | 推荐结论 | 涉及文件 |
| --- | --- | --- | --- | --- |
| S-1 | Worktree 跨分组显示与排序冲突 | P1 | 按分组内实际相邻关系决定是否树形缩进；不强制用 `space.move` 打乱已分组 worktree | `mods/kent/main.js` |
| S-2 | `kent.groups.v1` 残留失效 space ID 清理 | P1 | 仅在目标机器 `layout === "ready"` 且写入/低频巡检时做保守惰性清理 | `mods/kent/main.js` |
| S-3 | `RECIPE.md` 文案与实现/预览图不一致 | P1 | 同步更新示例组名与菜单项文案及顺序 | `RECIPE.md` |
| S-4 | `generate-preview.py` 中未上报状态的 demo app 配置 | P2 | 保持 4 个 Agents 列表简洁，将非 agent 演示行改为真实意图（或独立工具脚本），避免虚假的 `codex`/`claude` 配置 | `scripts/generate-preview.py`（可选重绘 `preview.png`） |
| S-5 | `icon-chip.js` 双份副本防漂移机制 | P2 | 增加轻量同步/校验脚本并在 `herdr-app check` 开发流程中调用 | `scripts/check.py`、`README.md`、`README.zh-CN.md` |
| S-6 | 亮色主题下 Spaces 与 Agents 单色图标着色统一 | P2 | 统一由 `iconChip` 的默认亮暗策略决定，或显式统一为 `t.muted` / `t.foreground` | `mods/kent-agents/main.js`、`mods/kent/icon-chip.js`、`mods/kent-agents/icon-chip.js` |
| S-7 | 分组弹窗、分组右键菜单与 `kent-agents` 交互打磨 | P3 | 禁用空输入提交并提示同机器重名、按位置隐藏无效上下移、对齐 `kent-agents` 细微交互 | `mods/kent/main.js`、`mods/kent-agents/main.js` |
| S-8 | 开发脚本健壮性增强（SVG 解析与预览进程兜底） | P3 | 跳过 `<defs>`/`<clipPath>`/`<mask>` 非渲染子节点；`stop_core` 超时兜底 `SIGTERM` | `scripts/generate-icon-metrics.py`、`scripts/generate-preview.py` |

---

## 详细设计

### S-1：Git linked worktree 跨分组显示与排序冲突（P1）

#### 现状与问题
- 在 `mods/kent/main.js`（第 656–695 行）的 `ordered()` 中，worktree 嵌套关系是跨全机全局计算的：只要任意 space 是该仓库主 checkout，linked worktree 就会被打上 `tree: "├─" | "└─"`，并且 `ordered()` 会调用 `run("space.move", ...)` 强行把 worktree 移到主 checkout 下方。
- 在 `machineRows()` 中，用户可将 worktree 单独拖入某个命名组（而主 checkout 留在 `default` 或另一命名组），或把主 checkout 与 worktree 调整到不相邻位置。此时该 worktree 在 `row()`（第 1232–1236 行）仍会：
  1. 缩进 `22px` 并显示 `branch.svg`（失去程序 icon chip），视觉上像是挂在无关 space 下方；
  2. 在 `gitTail()` 中因为 `tree` 为真而隐藏 repo 名，丢失仓库上下文。

#### 方案对比
- **方案 A（推荐）：按分组内实际展示关系计算 `tree`**
  - 仅在主 checkout 与 linked worktree 属于**同一分组**（同属某一命名组，或同属 `default`）且在组内按主 checkout → worktree 连续展示时才启用 `tree` 缩进。
  - 若 worktree 被单独放入另一分组，则 `tree = null`：正常展示程序 icon chip 与完整 `repo · branch` git tail。
  - 对命名组内的 spaces，`ordered()` 仅针对 `default`（未分组）spaces 触发 `space.move` 归位，不再和命名组顺序互相拉扯。
- **方案 B：强制 worktree 跟随主 checkout 移动分组**
  - 移动主 checkout 时自动连带移动其所有 worktree，禁止单独分组 worktree。
  - **缺点**：违反 Kent“分组完全手动、不隐式改成员”的原则，且如果用户只想把某个实验性 worktree 放进 `experiments` 组，会无法实现。

#### 推荐实现细节
1. 拆分 `ordered()` 的两项职责：
   - 保留 `default` 组的 worktree 嵌套与 `space.move` 逻辑（保持 `README` 承诺的“`default` 组沿用 Herdr 原有排序与 worktree 嵌套”）。
   - 对每个命名组内的 `members` 列表：检查某条 linked worktree 行在组内的上方是否存在同 `repo` 的主 checkout（且中间没有被其他 repo 隔断，或主 checkout 就在同组内紧邻上方）；仅满足时保留 `tree`（并按同组连续子项重新计算 `├─` / `└─`），否则置 `tree: null`。
2. 窄栏（`collapsed`）下不展示树形缩进，行为不变。

#### 验收标准
- 主 checkout 与 linked worktree 同在 `default` 时，嵌套缩进与 Herdr 原生 `spaces` mod 一致。
- 将 linked worktree 单独拖入命名组（主 checkout 仍在 `default`）后，该 worktree 以普通 space 行渲染：显示程序 icon chip，git tail 显示完整 `repo · branch`，无孤立缩进。
- 将主 checkout 与 linked worktree 拖入同一命名组并相邻时，恢复树形缩进显示。

---

### S-2：`kent.groups.v1` 中失效 space ID 的保守惰性清理（P1）

#### 现状与问题
- `shared.json` 下的 `kent.groups.v1.in[groupId]` 只增不减（`mods/kent/main.js` 第 104–121 行）。长期使用后，已关闭的 space ID 会不断累积在数组中，增加 `shared.json` 体积与 `readStore()` / `machineRows()` 的遍历开销。
- **风险点**：远程机器断连、休眠或刚启动尚未加载完成时，其 spaces 暂时不在 `spaces()` 返回列表中；若直接按当前 `spaces()` 全量裁剪，会误删远程机器的分组配置。

#### 推荐实现细节
- **触发时机**：不放在 `render()` 内高频写入 `shared.json`，而是在以下安全时机做惰性清理：
  1. 在 `checkNew()`（或 `refreshMachines()` 之后，每 60 秒最多一次的节流周期内）检查是否存在可安全清理的条目；
  2. 在发生写操作（`assignToGroup` / `deleteGroup` / `createGroup`）顺带写回 store 时。
- **安全判定条件（必须全部满足才清理某台机器下的分组）**：
  1. `machines()` 中存在该机器条目且 `layout === "ready"`（本机对应 `name === null`）；
  2. 当前处于非 `checking()` 模式；
  3. 仅当该机器在 `spaces()` 中至少返回 1 个 space，或应用已启动超过宽限期（例如 10 秒）且 `layout === "ready"`；
  4. 仅移除该机器所属分组中、既不在当前 `spaces()` 里、也不在 `this.newSpaceRequests` 挂起创建中的 space ID；
  5. 仅在确实移除了至少 1 个失效 ID 时才调用 `writeStore()`，避免无意义写盘。

#### 验收标准
- 关闭本机某个已分组 space 后，一段时间后（或下次分组写入时）该 ID 从 `kent.groups.v1.in` 移除。
- 远程机器离线 / `loading` / `unavailable` 时，其分组内的所有 space ID 100% 保留，不被误删。

---

### S-3：`RECIPE.md` 文档与实现对齐（P1）

#### 现状与问题
- `RECIPE.md` 第 3 行：
  > spaces can be filed under named groups such as “探针设计” and “代码”
  其中 “探针设计” 疑似早期个人工作区名称残留，与 `README.md`（`design`, `code`, `experiments`）及 `preview.png` 不一致。
- `RECIPE.md` 第 22 行：
  > Right-click a space for a keyboard-navigable menu: Open, Rename, Move to default, one “Move to …” item for each named group on that machine, “Group this space…”, and Close. On git checkouts the same menu also includes Herdr's New/Open/Remove worktree actions.
  实际菜单项为 `Open`、`Rename`、（若为 git 仓库：`New worktree`、`Open worktree`，若为 linked worktree：`Remove worktree`）、分隔线、`Move to default`、`Move to …`、`Group this space…`、分隔线、`Close space`。

#### 推荐改动
- 将 `RECIPE.md` 第 3 行改为与 `README.md` 和 `preview.png` 一致的示例组名（如 `` `design` ``、`` `code` ``、`` `experiments` ``；中文组名支持已在第 56 行 `Done when` 明确说明）。
- 将 `RECIPE.md` 第 22 行修正为 `Close space`，并准确反映 worktree 菜单项位于 `Rename` 之后。

#### 验收标准
- `RECIPE.md`、`README.md`、`README.zh-CN.md`、`preview.png` 与 `mods/kent/main.js` 的菜单标签、示例组名完全一致。

---

### S-4：`scripts/generate-preview.py` 中未上报状态的 demo app 配置（P2）

#### 现状与问题
- `scripts/generate-preview.py` 第 369–377 行中：
  - `("canvas-redesign", "tokens", "", "codex", "codex · tokens")`
  - `("agent-lab", "evals", "", "claude", "claude · evals")`
- 因为 `state=""`，`HELPER` 不会发送 OSC 7501 序列，Herdr 识别到的程序是 Python（`demo_agent.py` 的解释器），所以在当前 `preview.png` 中 `canvas-redesign` 实际显示的是绿色 Python 图标而非 Codex 图标。

#### 方案对比
- **方案 A（推荐，不改变当前预览图结构）**：若希望 Agents 列表保持 4 行精简状态，就把 `canvas-redesign` 和 `agent-lab` 的 `app` 参数改回 `"python"`（或去掉易误导的 `"codex"` / `"claude"` 字面量），并同步标题，让脚本配置与实际渲染一致。
- **方案 B（让预览图图标更丰富）**：若希望 Spaces 侧栏展示多样的真实工具图标（如 `git`、`nvim`、`node`、`python` 等）而不增加 Agents 列表行数，可为非 agent 演示行启动轻量的非 agent 占位命令（或通过临时的 `programs.json` 在隔离预览环境中映射演示程序名到指定 icon），再执行 `python3 scripts/generate-preview.py` 重绘 `preview.png`。

#### 推荐结论
- 优先选 **方案 B**（在隔离 `app_home` 中写入仅用于预览的 `programs.json`，或用不同程序演示非 agent 图标），可以让 `preview.png` 的 Spaces 侧栏同时展示多样化的非方形 icon chip（充分体现 Kent 的可见边界适配特性），同时保持 Agents 列表只有 4 个聚焦的 agent 行。如果不想改动当前 `preview.png`，则选 **方案 A**。

#### 验收标准
- `specs` 中不再存在“写了 `codex`/`claude` 却实际显示为 Python 图标”的无效配置；若采用方案 B，重新生成 `preview.png` 并人工核验视觉效果。

---

### S-5：`icon-chip.js` 双份副本的防漂移机制（P2）

#### 现状与问题
- 由于 Herdr 按独立目录加载/安装每个 mod，`mods/kent/` 与 `mods/kent-agents/` 各自保存一份 `icon-chip.js` 和 `icon-metrics.js`。
- `icon-metrics.js` 由 `scripts/generate-icon-metrics.py` 同时写入两处，天然不会漂移；但 `icon-chip.js` 纯手工维护，修改一处很容易漏改另一处。

#### 推荐实现细节
- 新增一个极简无依赖的校验脚本 `scripts/check.py`（或 `scripts/sync-shared.py`）：
  - 默认校验模式：检查 `mods/kent/icon-chip.js` 与 `mods/kent-agents/icon-chip.js`、`mods/kent/icon-metrics.js` 与 `mods/kent-agents/icon-metrics.js` 字节一致；同时校验 JSON 文件和 manifest 合法性，可选自动运行 `herdr-app check` 检查三个 mod。
  - `--sync` 模式：以 `mods/kent/icon-chip.js` 为源同步到 `mods/kent-agents/icon-chip.js`。
- 不使用符号链接（symlink），因为手动 `cp`、部分打包工具或 Windows 环境对 symlink 兼容性差。
- 在 `README.md` / `README.zh-CN.md` 的 Development 章节补充一行校验命令。

#### 验收标准
- 运行 `python3 scripts/check.py` 在一致时返回 0；人为改动其中一份 `icon-chip.js` 时返回非 0 并指出差异文件。

---

### S-6：亮色主题下 Spaces 与 Agents 单色图标着色一致（P2）

#### 现状与问题
- `mods/kent/main.js`（第 167 行）调用 `iconChip(p, t, { slot: 20, max: 18, empty: true })`，未传 `color`，当程序为 `tint: true` 且无 `p.color` 时：暗色主题用 `t.foreground`，亮色主题用 `t.muted`。
- `mods/kent-agents/main.js`（第 192、321 行）传了 `color = t.foreground`，因此在亮色主题下，Agents 里的同款单色图标（如 `agent.svg`）比 Spaces 里颜色更深。

#### 推荐实现细节
- 在 `mods/kent-agents/main.js` 中移除显式传入的 `t.foreground`（或将 `icon(p, t, size)` 改为不传 `color`），让 Spaces 与 Agents 完全走同一套 `iconChip` 的明暗自适应着色规则：`p.color ?? (dark ? t.foreground : t.muted)`。
- 这样同一程序在侧栏上下两个列表中视觉完全一致，同时也简化了 `icon()` 签名。

#### 验收标准
- 切换 Herdr 到亮色主题后，Spaces 与 Agents 中相同无色单色图标（`tint: true, color: null`）颜色一致。

---

### S-7：分组弹窗、分组菜单与 `kent-agents` 细微交互打磨（P3）

#### 1. 分组创建/重命名弹窗（`mods/kent/main.js` 第 1091–1121 行）
- **现状**：
  - 允许同机器创建完全重名的分组（造成右键菜单中出现两个一模一样的 `Move to xxx`）；
  - 输入为空或纯空白时，按回车或点击 `Create`/`Rename` 会直接关闭弹窗，容易误以为操作成功；
  - `init()` 注册了 `this.input.on("change", (_e, cx) => cx.notify())`，但 `renderPrompt()` 从未读取输入值，按键重绘完全浪费。
- **推荐改动**：
  - 在 `renderPrompt()` 中读取 `const name = this.input.value().trim();` 并检查同机器是否存在重名分组（重命名时排除自身 `g.id === p.group`，比较时可按 `trim()` 精确匹配或大小写不敏感匹配，推荐按 `trim()` 精确匹配以保持对大小写及中英文的直觉）。
  - 当 `!name` 时，主按钮呈现禁用态（降低透明度、非 pointer 光标、不触发提交），按回车也不关闭弹窗。
  - 当同机器已有同名分组时，在输入框下方显示一行 `11.5px` 提示（如 `A group named “…” already exists`）并阻止提交；输入框也同步追踪 `inputFocused` 以切换边框色（对齐 Herdr 原生 `mods/prompt/main.js`）。
  - 在弹窗 `close()` 钩子中调用 `this.input?.release()` 及时释放文本输入状态。

#### 2. 分组右键菜单 `Move up` / `Move down`（`mods/kent/main.js` 第 970–983 行）
- **现状**：即使只有一个分组，或该分组已在最顶/最底，右键菜单仍显示 `Move up` 和 `Move down`，点击后静默无反应。
- **推荐改动**：根据当前机器的分组列表计算 `own` 下标与总数：
  - 仅在 `own > 0` 时包含 `Move up`；
  - 仅在 `own < machineGroups.length - 1` 时包含 `Move down`；
  - 若两者皆不显示（仅有一个分组），同时省略该段分隔线，菜单更干练。

#### 3. `mods/kent-agents/main.js` 继承自上游的细节对齐
- **`subRow` 选中态 hover**（第 203–204 行）：改为 `.when(!on, (el) => el.hover((s) => s.bg(t.hover)))`，与父级 agent 行和 space 行保持一致。
- **按 space 分组折叠标题紧急度**（第 413 行）：`top` 状态改为参考 `rankOf(a)`（即包含子 agent 紧急度），避免父 agent `idle` 而子 agent `blocked` 时折叠后丢失红色提醒。
- **空态文本水平内边距**（第 477 行）：将 `px(12)` 改为 `px(16)`，与上方 `"Agents"` 标题（`px(16)`）左对齐。

#### 验收标准
- 弹窗空输入无法提交，同机器重名时有明确提示；正常输入回车/点击提交生效。
- 单个分组的右键菜单不出现无效的 `Move up` / `Move down`；首/末分组仅展示有效方向。
- `herdr-app check mods/kent`、`herdr-app check mods/kent-agents` 和 `herdr-app check mods/kent-updater` 均通过；`python3 scripts/build-manifest.py --check` 通过。

---

### S-8：开发脚本健壮性增强（P3）

#### 1. `scripts/generate-icon-metrics.py`
- **现状**：使用 `root.iter()` 遍历所有后代节点，未排除 `<defs>`、`<clipPath>`、`<mask>`、`<symbol>` 内的不可见定义形状；也未解析 SVG `transform` 属性。
- **推荐改动**：
  - 将 `root.iter()` 替换为递归遍历函数，遇到 `defs` / `clipPath` / `mask` / `symbol` / `pattern` 容器时直接跳过子节点（避免未来图标把全画布裁剪矩形或离屏模板放进 `<defs>` 导致可见边界被污染）。
  - 同时把父级 `<g>` 的 `fill` / `stroke` 属性向下继承传递（比只继承根 `<svg>` 属性更准确）。
  - 至于完整的 SVG `transform` 矩阵解析，因当前 124 个内置 SVG 均未使用 `transform`，暂无需引入重依赖；可在遇到 `transform` 属性时向 `stderr` 打印一条 warning 提示人工复核。

#### 2. `scripts/generate-preview.py`
- **现状**：`stop_core()` 调用 `hc server stop` 后最多等待 4 秒，若孤立 core 进程仍未退出会直接返回；`settings.json` 写死了 `"JetBrainsMono Nerd Font Mono"`。
- **推荐改动**：
  - `stop_core()` 在 4 秒等待结束后若 `pid` 仍存活，发送 `SIGTERM` 并短暂等待退出，避免孤儿 core 进程泄漏。
  - 为 `generate-preview.py` 增加可选 `--font` 参数（默认仍为 `"JetBrainsMono Nerd Font Mono"`，保持当前截图风格稳定），便于其他开发者按本机字体复现。

#### 验收标准
- 使用更新后的 `generate-icon-metrics.py` 重新生成，检查 124 个图标指标无异常回退（尤其核对 `antigravity.svg` 与 `kiro.svg`）。
- `python3 -m py_compile scripts/generate-icon-metrics.py scripts/generate-preview.py` 通过。

---

## 建议实施顺序

1. **第一批（低风险、高收益）**：S-3（修正 `RECIPE.md`）、S-5（增加双份文件同步校验脚本）、S-6（亮色主题单色图标统一）、S-8（脚本健壮性增强）。
2. **第二批（核心逻辑演进）**：S-1（worktree 跨分组渲染与排序解耦）、S-2（失效 space ID 保守惰性清理）。
3. **第三批（交互打磨与预览刷新）**：S-7（弹窗/菜单/Agents 细节打磨）、S-4（根据选定方案更新预览脚本并决定是否重新生成 `preview.png`）。

## 总体验证清单

实施完成后统一执行：
- `herdr-app check mods/kent`
- `herdr-app check mods/kent-agents`
- `herdr-app check mods/kent-updater`
- `python3 scripts/build-manifest.py --check`
- `python3 scripts/check.py`（若落地 S-5）
- `python3 -m py_compile scripts/*.py`
- `uv run --with svgpathtools python scripts/generate-icon-metrics.py`
- 在隔离或真实 Herdr 窗口中手测：跨分组拖拽 worktree、关闭本机 space 观察 `kent.groups.v1` 清理、亮/暗主题切换对比 Spaces 与 Agents 图标、分组弹窗空输入与重名校验、首/末分组右键菜单。
