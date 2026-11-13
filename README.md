# dsh-session-migrator

把旧会话**迁移出 DSH 会话列表**，并在需要时恢复。

## 功能

- 设置 → **会话迁移**。
- 迁移条件：将 **X 个月以前**的会话迁出；时间范围可填 **0–120**，`0` 表示不限时间（包含本月），扫描结果默认不勾选。
- 默认**不迁移**带「备注」或「待办」标记的会话；必须先勾选「允许选择带备注或待办标记的会话」，再手动勾选具体会话。
- 扫描结果和归档列表都**按工作区分类，再按最后活动月份分组**；工作区顺序跟随 DSH 当前 `workspaceIds`，工作区重排会同步；已删除的工作区保留原归档分组并排在最后；每个月可全选。
- 已迁移条目会保存迁移时的 `workspaceId / workspaceTitle / workspacePath`，工作区删除后归档列表仍显示「原工作区名（已删除）」分组。
- 列表中显示会话的 **Git 分支**（来自 `dsh-session-branch` 的记录；分离 HEAD 显示短 commit）、父会话信息和 DSH 归档状态。
- 迁移目录默认是 `$DSH_HOME/session-migrator/archive`，页面「迁移目录」可填写其他绝对目录；执行迁移时保存该设置，之后仍可在归档列表恢复。
- 迁移/恢复超过 200 个会话时客户端自动分批请求；一次迁移的多个批次会合并到同一个「一键恢复本次迁移」范围。
- 迁移后提供「一键恢复本次迁移」；归档列表支持多选恢复与全部恢复。
- 归档列表显示每个会话的：
  - 标题、原工作目录、最后活动日期、大小；
  - 备注/待办的内容、类型与完成状态；
  - 是否在 DSH 中**已归档**（恢复后保持原状态）。
- 恢复后会话回到原来的项目目录与会话目录，DSH 会话列表可正常打开；已归档的会话仍在 `archivedSessionIds` 中，因此继续处于归档状态。

## 工作原理

DSH 的 JSONL 持久化后端把每个会话存成 `$DSH_HOME/sessions/<项目目录>/<会话目录>/session.vN.jsonl.zstd`。本插件把**整个会话目录**移动到插件归档目录，因此 `sessionPersistence.list()` 不再列出它，DSH 会话列表随之消失；恢复时再整体移回原路径。文件只移动，不删除、不重写。

数据目录：

```text
$DSH_HOME/session-migrator/
  entries/<session-id>.json   # 每个已迁移会话的索引、原路径、实际归档路径与展示元数据
  archive/<session-id>/       # 默认归档根下的原会话目录
  state.json                  # archiveRoot（用户手选的迁移目录）与上次迁移批次
```

迁移目录可在页面手动指定；每个 entry 保存实际 `archiveDir`，所以修改默认目录不会影响旧归档的恢复。归档根不能位于 `$DSH_HOME/sessions` 内。

归档状态来自 `workspaceRegistry.archivedSessionIds`，本插件不修改 `storages/workspace.json`，所以：

- 迁移一个已归档会话 → 恢复后仍然是归档状态；
- 迁移一个正常会话 → 恢复后正常显示。

工作区删除后：DSH 的 workspace 记录连同 `sessionIds` 归属一起删除，恢复的会话仍能打开（`cwd` 保留），但会作为「未分组」会话出现；如果该会话原本已归档，恢复后仍在归档集合中。之后重新创建同路径工作区也不会自动把旧会话重新挂回去。

## HTTP 路由

客户端只通过以下 loopback 路由访问宿主（全部 `POST`，要求请求头 `x-dsh-session-migrator`）：

| 路由 | 用途 |
|---|---|
| `/session-migrator/scan` | `{ months }` → 可迁移会话与统计 |
| `/session-migrator/migrate` | `{ months, sessionIds, allowMarked }` → 迁移所选 |
| `/session-migrator/archive` | `{}` → 归档列表与上次迁移批次 |
| `/session-migrator/restore` | `{ sessionIds }` → 恢复所选 |

路由限定 loopback（或已配对的 remote-web-ui 设备），拒绝跨站表单；响应带 `cache-control: no-store`。

## 已知边界

- 只支持提供 `location.path` 的按会话文件后端（当前产品自带的 JSONL 后端）；其他后端会在扫描时跳过并计入统计。
- 正在运行的会话、subagent 子会话、空白新会话与没有 `cwd` 的会话不会迁移。
- 同一个 `$DSH_HOME` 被 desktop/web 两个 profile 共用时，另一个进程正在写的会话可能在移动时报文件占用；该会话会出现在失败列表里，不影响其他会话。
- 迁移后 DSH 会话列表的刷新依赖客户端的 `sessions.refresh()`；如果当前版本没有该方法，重新加载页面即可看到最新列表。
- 归档目录中的会话仍占用磁盘；本插件不删除会话数据。
- Host 侧 `index.js` / `lib/*.js` 的改动需要重启 DSH 进程才会加载新模块；`client.js` 刷新页面即可。
