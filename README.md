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
| 恢复文本选择 | 覆盖 `user-select: none` 样式，并拦截 `selectstart` / `select` 事件 |
| 恢复右键菜单 | 拦截页面 `contextmenu` 阻止逻辑，浏览器默认菜单正常弹出 |
| 恢复复制 / 剪切 | 拦截 `copy` / `cut` 劫持，防止粘贴时被附加版权尾巴或追踪链接 |
| 恢复快捷键 | 放行 `Ctrl/Cmd + A C X S U P` 及 `F12`，不影响页面其他键盘交互 |
| iframe 全覆盖 | `all_frames: true`，内嵌框架中的内容同样生效 |
| 一键开关 | 工具栏弹窗全局启停，当前标签页立即生效，状态持久化 |

## 🚀 安装

1. 克隆或下载本仓库
   ```bash
   git clone https://github.com/L-1ngg/enable-copy-extension.git
   ```
2. 打开 `chrome://extensions`（Edge 用户为 `edge://extensions`）
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择仓库目录
5. 点击工具栏中的扩展图标即可打开 / 关闭功能

## ✅ 效果验证

仓库内置 `test-page.html`，模拟了五种常见防复制手段（禁选择、禁右键、复制劫持、禁快捷键、CSS 限制）：

- **扩展关闭时**：无法选中文字、右键被拦截、粘贴内容被篡改
- **扩展开启时**：以上限制全部解除（若页面在开关切换前已打开，刷新一次即可）

## 🔧 工作原理

内容脚本在 `document_start` 阶段注入，**早于页面脚本注册事件监听器**。在 `window` 捕获阶段对
`contextmenu` / `copy` / `cut` / `selectstart` / `select` 调用 `stopImmediatePropagation()`，
事件在到达页面处理函数之前就被放行，浏览器默认行为（选择、复制、右键菜单）自然恢复。

同时注入 `user-select: auto !important` 样式覆盖 CSS 限制，并通过 `MutationObserver`
在样式节点被页面移除时自动重新注入。

扩展仅申请 `storage` 一项权限，不联网、不收集任何数据。

## ⚠️ 使用限制

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
