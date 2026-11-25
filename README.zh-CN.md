# Kent for Herdr

[English README](README.md)

Kent 是一个适合同时打开很多 spaces 的 Herdr layout。它保留 Herdr 主窗口的实用结构，同时把 Spaces 侧栏变成按机器划分的命名分组列表。

![Kent](preview.png)

## 功能

- 可以把 spaces 放入 `设计`、`代码`、`实验` 等命名分组。
- 分组按机器隔离；本机和远程机器的 spaces 不会混在一起。
- 分组标题可以折叠/展开，显示成员数量；折叠后仍会显示 blocked/done 状态。
- space 行使用带主题感知对比边缘的 program icon chip，并显示名称、git 仓库/分支信息和 agent 状态；内置 SVG icon 会按可见矢量边界适配，因此竖向或横向图形都能保持自己的方向，不再被拉成方形。
- Agents 列表通过内置的 `kent-agents` mod 使用同一套 icon chip。
- 可以通过右键菜单把 space 放入分组，也可以直接拖到分组标题上。
- 可以在组内排序、在分组之间拖动，也可以拖出来变成未分组。
- 保留 Herdr 原有的 worktree 嵌套、机器分组、git 信息和 space 排序行为。
- 很窄的侧栏下仍然支持紧凑的编号 rail 模式。

## 安装

### 从 Herdr Gallery 安装

等 Gallery 完成索引后，打开：

<https://herdr.dev/layouts/bioShaun/herdr-kent>

### 手动安装

把 layout 和 mod 复制到 Herdr home。如果你使用自定义 `HERDR_APP_HOME`，请把下面的 `~/.config/herdr-app` 替换成你的目录。

```sh
git clone git@github.com:bioShaun/herdr-kent.git
cd herdr-kent

cp layouts/kent.json ~/.config/herdr-app/layouts/
mkdir -p ~/.config/herdr-app/mods/kent ~/.config/herdr-app/mods/kent-agents
cp mods/kent/main.js mods/kent/mod.json ~/.config/herdr-app/mods/kent/
cp mods/kent-agents/main.js mods/kent-agents/mod.json ~/.config/herdr-app/mods/kent-agents/

herdr-app check ~/.config/herdr-app/mods/kent
herdr-app check ~/.config/herdr-app/mods/kent-agents
herdr-app do layout.switch '{"name":"kent"}'
```

这个安装不会修改原有的 `main` layout。可以用 `ctrl-shift-l` / `cmd-shift-l` 循环切换 layout，也可以手动切回：

```sh
herdr-app do layout.switch '{"name":"main"}'
```

## 可选快捷键

仓库里的 `keys.json` 是可选绑定。不要用它完整覆盖你的 Herdr `keys.json`；只需要把其中的 `layout:kent` section 合并进去：

```json
{
  "layout:kent": {
    "alt-down": "kent.next",
    "alt-up": "kent.prev",
    "ctrl-shift-pagedown": "kent.next",
    "ctrl-shift-pageup": "kent.prev"
  }
}
```

这些快捷键会按照 Kent 实际显示的顺序切换 spaces，并跳过折叠分组里隐藏的行。

## 使用分组

- 右键一个 space 打开菜单。
- 选择 `Group this space…` 创建包含该空间的新分组。
- 选择 `Move to …` 移入已有分组。
- 选择 `No group` 移出分组。
- 把 space 拖到分组标题上，会加入该分组。
- 把 space 拖到另一行附近，可以调整顺序。
- 拖动已分组 space 时，列表底部会出现 `Drop here to ungroup`，拖到这里可以移出分组。
- 单击分组标题可以折叠或展开。
- 右键分组标题可以重命名、上下移动、折叠/展开或删除分组。删除分组不会关闭其中的 spaces。

对于 git checkout，space 菜单还会显示 Herdr 的 worktree 操作：`New worktree`、`Open worktree`；linked worktree 还会显示 `Remove worktree`。

## 主题行为

Kent 不再写死亮色或暗色主题。它会跟随 `settings.json`、系统外观和 Herdr 的 theme picker。切换亮/暗 appearance 或主题时，Spaces 和 Agents 都会重绘，icon 边缘颜色也会随主题反转。

## 注意事项和限制

- 分组是手动维护的；Kent 不会根据路径、名称前缀或 tag 自动分组。
- 分组不能跨机器。两台机器上同名分组是相互独立的。
- 分组状态保存在本机 Herdr shared state 的 `kent.groups.v1` 里，不会同步到其他 Herdr 客户端。
- 组内排序由 Kent 管理；未分组 spaces 仍使用 Herdr 自己的排序。
- Kent 是基于 Herdr 0.1.18 开发和测试的。
- 可见边界数据目前覆盖 Herdr 0.1.18 自带的 SVG icon；未来 Herdr 新增 icon 后可以用 `scripts/generate-icon-metrics.py` 重新生成。未知自定义 icon 仍会退回方形适配。

## 开发

Spaces mod 源码在 `mods/kent/main.js`；Agents 变体在 `mods/kent-agents/main.js`；layout 树在 `layouts/kent.json`。

在仓库根目录验证 mod：

```sh
herdr-app check mods/kent
herdr-app check mods/kent-agents
```

Herdr 更新自带 icon 集后，可以在仓库根目录重新生成 icon 边界数据：

```sh
uv run --with svgpathtools python scripts/generate-icon-metrics.py
```

`RECIPE.md` 是按照 Herdr Gallery 格式编写的详细实现说明。

## License

Apache License 2.0。Kent 包含 Herdr 官方 `spaces` 和 `agents` mods 的衍生代码，详见 `NOTICE`。
