# Yeaft 产品演示

主题：**从请求到可检查的工程结果**。面向第一次了解 Yeaft 的工程师，保留暖白、棕色强调的极简版式。

## 叙事边界

- 第 3 页是产品地图：Browser → Server（鉴权、中继）→ local Agent。Session 与 Work Center 职责、身份和历史分开，不暗示自动迁移。
- 第 4–11 页贯穿同一只读检查示例：查看 `agent/yeaft/session.js` 并运行 `node --check agent/yeaft/session.js`。没有声称示例修改了源码、完成行为测试或获得真实 PR 批准。
- 第 4 页证明请求与结果可见；第 5 页证明成员与具名贡献可见；第 6 页解释不同职责；第 7 页是唯一交接流程。
- 第 8 页使用实际 Files / Terminal 组件，不使用手写 HTML 仿造文件树、编辑器或终端。
- 第 9 页解释 WorkItem / Action / Run；第 10 页解释限制；第 11 页是具体证据清单，不重复执行时间线。
- Work Center 标为 Preview；`read` 不是 sandbox；语法检查不等于运行正确。

## 成品与来源

- `yeaft-editorial-minimal.pptx`：12 页演示文稿。
- `yeaft-editorial-minimal-package.zip`：包含与独立文件字节一致的 PPTX、6 张图片、`assets/capture-manifest.json` 和本说明。
- `assets/capture-manifest.json`：截图的代码版本、尺寸和检查命令记录。
- `capture-workbench.cjs`：真实 UI 的隔离截图入口；演示数据只在 fixture / transport 层提供。
- `generate-showcase-pptx.cjs`：PPTX 与 ZIP 生成器。

所有截图页单独标注 **Real Yeaft UI / Staged inspection demo**。界面中的示例 reviewer 发言不等于本 PR 的独立审查。终端展示的是截图脚本采集后回放的命令结果，不是在线 Agent 的生产记录。

## 生成和检查

从仓库根运行 `npm run showcase:build`。该入口必须先完成实际截图，再打包；缺失图片或 manifest 时构建失败。生成器读取 PNG 的实际宽高，不再写死纵横比。

字体使用可免费安装的 **Liberation Sans**；查看端需要该字体，否则 PowerPoint 可能替换字体。最终验收须从实际交付 PPTX 渲染 PDF / PNG，不能把截图检查或 XML 检查当成幻灯片视觉验收。

检查要点：

1. 缩略总览：每页只有一个明确论点，3/11 页用途不同。
2. 4/5/8 页：普通演示尺寸下看得清关键请求、具名贡献、路径、命令和结果；没有空白错误布局、竖排标签、裁切。
3. 图片均为最新组件、无生产数据，示例标记可见。
4. 第 12 页链接可点击并指向正式仓库 README。
5. ZIP 内 PPTX 与单独交付文件相同；真实构建/测试证据写入 PR，不混进 staged 演示内容。
