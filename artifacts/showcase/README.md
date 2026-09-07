# Yeaft 产品演示

主题：**手机是入口，AI 团队是执行者，任务完成才是目标。** 面向首次了解 Yeaft 的开发者和技术产品观众，保留 12 页暖白、棕色强调的英文极简版式，配中文演讲备注。

## 内容主线

1. 产品定位：Your AI team. Real work. From anywhere.
2. 用户痛点：不在电脑旁、多角色协作、逐轮催促。
3. 跨设备原理：手机 / 桌面 Browser → Server → 所选 Agent。
4. 手机使用：真正的移动端 UI，项目与执行环境留在 Agent。
5. 多 VP：一个 Session 中的不同职责和可见贡献。
6. 可控 System Prompt：VP persona、Project instruction、仓库规则。
7. 面向任务：从逐轮对话转为目标、约束和验收条件。
8. 真实工具：Files / Terminal 支撑执行和检查，不抢占主叙事。
9. Work Center：持久目标、工作状态和执行记录。
10. 有边界的自动化：自动推进，需要判断时由用户介入，以验收为准。
11. 竞争力总结：跨设备 + 多 VP + 指令可控 + 任务自动化的组合价值。
12. 行动：连接机器、定义团队、从手机交付一个有验收标准的目标。

完整中文讲稿、建议 Demo 和事实边界见 `showcase-talk-track.md`；同一讲述意图也写入每页 PPT speaker notes。

## 成品与来源

- `yeaft-editorial-minimal.pptx`：12 页英文演示文稿，带中文演讲备注。
- `yeaft-editorial-minimal.pdf` / `showcase-preview.png`：从最终 PPTX 渲染的 PDF 和总览图，供人工检查；这两个预览文件在渲染后复制更新，不由 `showcase:build` 自动更新，也不放入源素材 ZIP。
- `yeaft-editorial-minimal-package.zip`：字节一致的 PPTX、7 张原始截图、capture manifest、本说明和中文讲稿。
- `assets/capture-manifest.json`：截图代码版本、尺寸和检查命令记录。
- `capture-workbench.cjs`：隔离截图入口，使用真实 Vue UI；数据与 transport 为 staged fixture。
- `generate-showcase-pptx.cjs`：PPTX 与 ZIP 生成器。

## 事实边界

- 所有截图页标注 **Real Yeaft UI / Staged inspection demo**。新增手机图是 390×844 浏览器 viewport 下的真实组件，不是手机硬件、公网跨设备接力或端到端任务成功记录。
- 截图中的示例仍是只读检查 `agent/yeaft/session.js`，Terminal 回放脚本实际采集的 `node --check` 结果。不将其包装为 bug 修复、行为测试或真实独立审查。
- 演讲中“修复 bug、增加回归测试、准备待审查 patch”是建议的完整演示场景，不是已完成案例或 benchmark。
- Work Center 保留 **Preview**。自动化受目标、可用工具、凭据、权限、验收与安全恢复边界约束；不承诺无限重试、永远无人介入或任意自主部署。
- 浏览器只是控制入口，执行发生在 Agent；需要可访问的 Server 和在线 Agent，不能在 Agent 离线时继续执行。
- Session 与 WorkItem 是不同的持久对象，不声称自动转换或共享 transcript。System Prompt 定义行为，但不是 OS sandbox。
- 不宣称市场唯一，不编造竞品缺陷、用户数量、效率提升或成功率。

## 生成与检查

从仓库根运行 `npm run showcase:build`，先截图再打包。最终交付 PPTX 可用 `sh artifacts/showcase/render-showcase.sh` 在现有隔离 Docker renderer 中渲染为 PDF / PNG。

字体使用 **Liberation Sans**；查看端缺少字体时 PowerPoint 可能替换。XML 和截图检查不替代实际 PPTX 渲染后的视觉验收。检查 4/5/8 页图像可读性、所有页文字溢出、12 页链接，以及 ZIP 中 PPTX 与单独文件一致性。真实构建 / 测试结果写入 PR，不混入 staged 演示内容。
