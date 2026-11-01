# 用 Agent 阅读和比较回忆

回响 0.4.0 提供本机只读 MCP。Agent 可以找到会话、读取初次记录与历次回忆，依据原文比较理解的变化。写入仍通过回响界面进行。

## 安装版接入

1. 安装并打开 [最新桌面版](https://github.com/Explainfuture/recallWhatYouExperienced/releases/latest)。正式使用笔记不需要 Node；连接 MCP 时另需安装 [Node.js 22 或更高版本](https://nodejs.org/en/download)。
2. 点击左侧底部的 **连接 Agent**。确认本机连接已就绪，选择 Codex 或通用 JSON，复制配置。
3. 将配置加入同一台电脑上的 Agent 客户端，重新加载其 MCP 服务。保持回响打开，然后让 Agent 调用 `recall_status` 检查连接。

配置使用安装包自带的 `mcp/server.mjs`，不需要下载源码或运行 `npm install`。应用显示的路径是当前安装位置，包含空格和中文时也可直接复制。配置中没有连接 token。

Codex 使用 `[mcp_servers.recall]` 表，配合 `command` 与 `args` 启动 stdio 服务。将应用生成的 TOML 加入 `~/.codex/config.toml` 中；不要覆盖已有的其他配置。此格式见 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml)。

通用 JSON 配置使用 `mcpServers.recall`。不同客户端的配置入口可能不同；服务类型选择 **stdio**，命令是 `node`，参数来自应用显示的配置。下例仅表示结构，路径以应用生成的为准：

```json
{
  "mcpServers": {
    "recall": {
      "command": "node",
      "args": [
        "C:/实际安装目录/mcp/server.mjs",
        "--bridge-file",
        "C:/用户本地数据目录/com.explainfuture.recall/mcp/bridge.json"
      ]
    }
  }
}
```

客户端必须在这台电脑上启动 Node。这里的私有 HTTP 数据桥不是 MCP HTTP 地址，不能作为远程服务器 URL 填入云端客户端。

可以对 Agent 说：

> 使用回响 MCP 找到“学习方法”这个会话，读取它的全部回忆。比较初次记录与后来理解的变化，引用具体的回忆次数和日期，给我三个下一次回忆值得思考的问题。

也可以使用 MCP 的 `review_session` 提示模板，传入找到的会话 ID。建议在你发起分析时生成；本版本没有自动定时分析或推送。

## 可用接口

所有工具均为只读，返回 JSON 文本与结构化结果。

| 名称 | 参数 | 用途 |
| --- | --- | --- |
| `recall_status` | 无 | 检查应用是否打开、数据桥是否就绪；不读取正文 |
| `recall_list_folders` | 无 | 列出全部分类及会话数量 |
| `recall_list_sessions` | `offset?`, `limit?`, `search?`, `folderId?` | 分页列出会话元数据，可按标题和文件夹筛选 |
| `recall_get_session_recalls` | `sessionId`, `offset?`, `limit?` | 按历史顺序读取初次记录及每次回忆的完整 Markdown |

- 分页默认 `offset=0, limit=50`，`limit` 最大 100。继续使用 `nextOffset` 读取到 `null`，避免只比较第一批记录。
- `folderId` 省略表示所有分类，`null` 表示未分类；`search` 仅匹配会话标题。
- 初次记录 `ordinal=0`，后续 `ordinal=N` 为第 N 次回忆；自定义 `title` 与序号分开。
- 结果保留记录 ID、时间、完整正文、读取时间 `capturedAt` 和数据版本 `dataRevision`。跨页时核对版本；变化则重新读取。
- 未保存的草稿不包含在结果中。连接关闭或出错会返回明确错误，不回退到旧快照。
- `recall://guide` 提供项目 [AGENTS.md](../AGENTS.md)，说明读取步骤、证据引用和比较方式；`review_session` 是现成的比较提示模板。

## 本地连接如何工作

```text
Agent 客户端
  └─ stdio → Node MCP server.mjs
                └─ 127.0.0.1 + 临时凭证 → Tauri 原生桥
                                             └─ 事件 → WebView / IndexedDB
```

桌面应用启动后，数据桥只监听 `127.0.0.1` 的随机端口，每次启动生成新凭证。它要求 Bearer 验证、拒绝 Origin 请求头与不匹配的 Host，只处理固定的只读路径。应用退出会停止连接并清理本次描述文件。

`GET /health` 返回连接状态；`GET /snapshot` 通过 `recall:mcp-read` 事件触发前端，在一个 IndexedDB 只读事务内取得当前保存的会话与文件夹。它不复制数据到另一份持久数据库。尚未就绪、读取失败或超时均不会返回部分笔记。

Node 每次读取本机描述文件，使用固定回环地址和路径发起请求，不读取笔记指定的路径、不跟随重定向、不使用环境中的 HTTP 代理。连接文件路径默认如下，实际值以应用界面为准：

| 平台 | 描述文件 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/com.explainfuture.recall/mcp/bridge.json` |
| macOS | `~/Library/Application Support/com.explainfuture.recall/mcp/bridge.json` |
| Linux | `$XDG_DATA_HOME/com.explainfuture.recall/mcp/bridge.json`，默认 `~/.local/share/...` |

`bridge.json` 含本机临时凭证，不应复制给 Agent、上传仓库或放进备份。连接对同一操作系统用户的进程开放，不能隔离同一用户权限下的恶意程序。回响本身不调用模型或上传笔记；接入后，工具返回的内容会交给你选择的 Agent，按该客户端的数据处理方式使用。

## 源码开发

```sh
npm ci
npm test
npm run build
npm run tauri -- dev
```

需要 Rust 与平台 Tauri 工具链，详见 [README](../README.md)。仅运行 `npm run dev` 是浏览器预览，没有原生数据桥；请打开桌面开发版或安装版进行 MCP 连接。预览和桌面版可能拥有不同的数据空间。

源码入口：`mcp/server.mjs`。在 MCP 客户端中设置命令 `node`，第一个参数是这个文件的绝对路径。也可以运行 `npm run build:mcp`，使用生成的 `dist-mcp/server.mjs`，同时保留旁边的 `AGENTS.md`。这个产物已包含依赖，不需要旁边有 `node_modules`。客户端直接启动 Node，不要通过 `npm run mcp`，以免 npm 的启动提示污染 stdio 协议。

JS 测试会使用虚构 HTTP 桥和真实 MCP SDK stdio 客户端，覆盖发现工具、参数校验、分页、完整长正文、实时读取、凭证错误和断开连接。原生桥测试由 Windows CI 运行。发布工作流提供 `Recall-Windows-x64` 和 `Recall-MCP` 产物；安装包中已经包含 MCP。

## 排查连接

- **找不到 node**：检查 `node --version` 是否为 22+。客户端若继承的是旧 PATH，重新启动客户端；或将 `command` 改为本机 `node.exe` 的绝对路径。
- **无法连接 / 尚未就绪**：打开回响桌面版，点击“连接 Agent”刷新状态。浏览器页面不能提供数据桥。应用启动或页面加载期间稍后重试。
- **配置找不到 server.mjs**：使用 0.4.0 或更新的完整安装版，重新复制应用内配置。移动安装位置后也需更新配置路径。
- **应用重启后凭证失效**：服务每次调用会重新读取凭证，直接重试即可。不要手工把 token 固定写入客户端。
- **找不到某条记录**：先确认它已点击保存，并存在于当前打开的桌面版。会话 ID 来自 `recall_list_sessions`，不可用标题代替。
- **列表未读完整**：检查 `nextOffset`。正文很长且宿主限制工具输出时减小 `limit`，不要把宿主截断的文本当作全部历史。
- **MCP resource 不存在**：单独移动服务器脚本时也要带上同目录的 `AGENTS.md`，或重新安装完整版本。
