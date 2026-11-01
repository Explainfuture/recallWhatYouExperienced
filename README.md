# 回响 · Recall

一个轻量的本地回忆笔记本：经历一件事，写下当时的感受，过一段时间再写一次。

## 使用

1. 新建事件，填写事件名称和初次记录，点击保存。
2. 下次打开，选择这个事件，点击“下一次回忆”，写下现在还能想起的内容。
3. 每次回忆都单独保存，保留之前的记录，方便对照理解的变化。

首次保存后，次日开始显示待回忆提示；每次回忆后，下一次提示安排在七天后。日期按设备所在时区的自然日计算，从当天零点起到期。你也可以随时提前回忆。提示只显示在应用内，不发送系统通知。

## 数据

- 事件和回忆保存在当前设备的 IndexedDB 中，不需要账号、服务器或联网同步。
- 可以导出 JSON 备份，并在另一份应用中导入。导入按事件和记录编号合并，不清空已有数据；发现冲突时取消整个导入。
- 浏览器预览、开发版和安装版可能使用不同的存储空间，迁移时请导出再导入。
- 清除浏览器或应用数据会影响本地记录，请按需保留备份。公开仓库只包含程序源代码，不包含你的笔记。

## 开发

技术栈：Tauri 2、React、TypeScript、Vite。数据层直接使用 IndexedDB，无数据库服务。

安装 Node.js 22 后运行：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址，即可在浏览器中体验。

```sh
npm test        # 数据保存、回忆计划和备份合并测试
npm run build  # 类型检查和前端生产构建
```

## 桌面应用

Windows 本地编译需要 Rust、Microsoft C++ Build Tools 和 WebView2。安装步骤见 [Tauri 官方环境准备文档](https://v2.tauri.app/start/prerequisites/)。

```sh
npm run tauri -- dev
npm run tauri -- build --bundles nsis
```

安装包输出到 `src-tauri/target/release/bundle/nsis/`。更多打包选项见 [Tauri Windows 安装包文档](https://v2.tauri.app/distribute/windows-installer/)。

仓库配置了 [GitHub Actions](https://github.com/Explainfuture/recallWhatYouExperienced/actions)：推送到 `main` 后先运行测试和前端构建，再编译 Windows x64 安装包。成功的工作流会提供 `Recall-Windows-x64` 构建产物；下载解压后运行其中的安装程序。也可以在 Actions 页面手动触发构建。

## 许可

[MIT](LICENSE)
