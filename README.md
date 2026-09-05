<div align="center">

<img src="icons/icon128.png" width="96" alt="Enable Copy logo">

# Enable Copy

**解除网页复制 / 选择 / 右键限制的轻量浏览器扩展**

*A lightweight Manifest V3 extension that restores copy, selection and right-click on any webpage.*

[![License: MIT](https://img.shields.io/github/license/L-1ngg/enable-copy-extension)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)](manifest.json)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Edge-lightgrey)](#安装)
[![Last Commit](https://img.shields.io/github/last-commit/L-1ngg/enable-copy-extension)](https://github.com/L-1ngg/enable-copy-extension/commits/main)

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 恢复文本选择 | 覆盖 `user-select: none` 样式，并拦截非交互区域的 `selectstart` 事件 |
| 恢复右键菜单 | 拦截页面 `contextmenu` 阻止逻辑，浏览器默认菜单正常弹出 |
| 恢复复制 / 剪切 | 有原生文本选区时拦截非交互区域的 `copy` / `cut` 劫持，保留编辑区及复制按钮事件 |
| 恢复快捷键 | 有原生文本选区时解除非交互区域的 `Ctrl/Cmd + A C X` 限制，保留其他快捷键 |
| iframe 覆盖 | `all_frames: true`，已注入的内嵌框架跟随顶层站点的设置 |
| 站点开关 | 默认关闭，按站点启用；同站点已打开的标签页和框架自动同步，设置持久化 |

## 🚀 安装

1. 克隆或下载本仓库
   ```bash
   git clone https://github.com/L-1ngg/enable-copy-extension.git
   ```
2. 打开 `chrome://extensions`（Edge 用户为 `edge://extensions`）
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择仓库目录
5. 在需要解除限制的网站，点击扩展图标并开启本站功能；其他网站保持关闭

站点按来源区分（协议、域名、端口），子域名分别设置。升级后不再沿用旧版全局 `enabled` 开关，需要重新启用所需站点。更新已解压扩展后，请在扩展管理页重新加载，并刷新原先打开的网页。

## ✅ 效果验证

仓库内置 `test-page.html`，模拟了五种常见防复制手段（禁选择、禁右键、复制劫持、禁快捷键、CSS 限制）：

- **扩展关闭时**：无法选中文字、右键被拦截、粘贴内容被篡改
- **本站启用时**：可选择并复制正文、打开右键菜单；同站点开关切换无需刷新

自动回归测试使用真实 Chromium 加载扩展并读取剪贴板，覆盖正常复制、自定义复制、编辑区、站点隔离及标签页 / iframe 同步：

```bash
npm ci
npx playwright install chromium
npm test
```

也可通过 `CHROMIUM_PATH=/path/to/chrome npm test` 使用已有的支持加载扩展的 Chromium。

弹窗布局另用 `npm run test:popup` 验证：通过 `chrome.action.openPopup()` 打开真实工具栏弹窗，检查 100%、125%、150% 显示缩放下的宽度、文字换行和控件位置。此测试需要图形环境；无桌面的 Linux 可运行 `xvfb-run -a npm run test:popup`。

## 🔧 工作原理

内容脚本在 `document_start` 阶段注入，默认不修改页面。仅在顶层站点已启用时，在 `window` 捕获阶段对
非交互区域的 `contextmenu` / `selectstart` 调用 `stopImmediatePropagation()`；`copy` / `cut` 和
`Ctrl/Cmd + A C X` 还要求存在原生文本选区。输入框、编辑区、按钮等保留页面事件，`select` 通知不再拦截。
这让浏览器默认复制可以绕过正文的限制，同时保留依赖网站脚本生成内容的常见复制流程。

每个内容脚本监听 `chrome.storage.onChanged`，同站点所有已打开页面及已注入框架同步启停。

同时注入 `user-select: auto !important` 样式覆盖 CSS 限制，并通过 `MutationObserver`
在样式节点被页面移除时自动重新注入。

扩展仅申请 `storage` 一项权限，不联网、不收集任何数据。

## ⚠️ 使用限制

- 强制解除无法可靠区分正文选区上的限制代码与合法自定义复制代码；复杂编辑器或表格如仍有异常，请关闭本站开关。仅排除标准编辑区无法覆盖所有网站实现。
- 对 `chrome://` 页面、Chrome 应用商店、内置 PDF 查看器无效（浏览器安全策略，所有扩展皆然）
- 图片 / Canvas 渲染的文字（如部分文库站点）并非真实文本，请配合截图 OCR 使用
- 字体混淆站点复制结果为乱码，属于字符映射问题，同样需要 OCR

## 📁 项目结构

```
enable-copy-extension/
├── manifest.json     # Manifest V3 声明
├── content.js        # 核心逻辑：事件拦截 + 样式注入
├── popup.html        # 工具栏弹窗界面
├── popup.js          # 开关状态管理
├── icons/            # 扩展图标（16/32/48/128）
├── test-page.html    # 防复制模拟测试页
└── LICENSE           # MIT 许可证
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。如果你的改动涉及新的拦截事件类型，请确认不会破坏编辑器、
拖拽交互等页面的正常行为。

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

## ⚖️ 免责声明

本扩展仅供个人阅读、学习、存档等合理使用场景。网页内容的版权归原作者所有，
请勿将复制的内容用于再发布或其他侵犯版权的用途。
