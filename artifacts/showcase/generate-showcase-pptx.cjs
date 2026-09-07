const pptxgen = require('pptxgenjs');
const JSZip = require('jszip');
const fs = require('node:fs/promises');
const path = require('node:path');

const outDir = __dirname;
const assets = path.join(outDir, 'assets');
const img = {
  home: '01-home.png',
  conversation: '04-session-conversation.png',
  mobile: '04-session-mobile.png',
  roster: '05-session-roster.png',
  files: '08-workbench-files-correct.png',
  terminal: '08-workbench-terminal-correct.png',
  work: '09-work-center-structure.png',
};
const C = { bg: 'F4F1EA', paper: 'FFFFFF', ink: '1D1D1B', muted: '686761', line: 'D7D2C8', accent: '8B5E3C', soft: 'E9E2D8' };
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Yeaft';
pptx.subject = 'Cross-device AI teams and task-oriented automation';
pptx.title = 'Yeaft — Your AI team. Real work. From anywhere.';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Liberation Sans', bodyFontFace: 'Liberation Sans', lang: 'en-US' };
pptx.defineSlideMaster({
  title: 'EDITORIAL', background: { color: C.bg },
  objects: [{ text: { text: 'YEAFT', options: { x: 0.65, y: 0.3, w: 1, h: 0.2, fontSize: 10, bold: true, color: C.ink, charSpacing: 2, margin: 0 } } }],
  slideNumber: { x: 12, y: 7.08, w: 0.6, h: 0.2, fontSize: 10, color: C.muted, align: 'right', margin: 0 },
});
function text(s, value, x, y, w, h, size = 16, color = C.ink, bold = false, extra = {}) {
  s.addText(value, { x, y, w, h, fontSize: size, color, bold, margin: 0, valign: 'mid', breakLine: false, ...extra });
}
function body(s, value, x, y, w, h, size = 16) {
  text(s, value, x, y, w, h, size, C.muted, false, { valign: 'top', paraSpaceAfterPt: 7 });
}
function line(s, x, y, w, color = C.line, width = 1) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width } });
}
function box(s, x, y, w, h, fill = C.paper) {
  s.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: fill }, line: { color: C.line, width: 0.6 } });
}
function title(s, label, heading, sub) {
  text(s, label.toUpperCase(), 0.68, 0.82, 11.9, 0.24, 11, C.accent, true, { charSpacing: 1.1 });
  text(s, heading, 0.68, 1.23, 11.95, 0.76, 30, C.ink, true);
  if (sub) body(s, sub, 0.7, 2.08, 11.65, 0.56, 15);
}
function slide(note) {
  const s = pptx.addSlide('EDITORIAL');
  s.addNotes(note);
  return s;
}
function demo(s, extra = '') {
  text(s, `Real Yeaft UI · Staged inspection demo${extra ? ` · ${extra}` : ''}`, 0.68, 7.03, 11, 0.28, 10, C.muted);
}
function label(s, n, heading, detail, x, y, w) {
  text(s, n, x, y, w, 0.25, 12, C.accent, true);
  text(s, heading, x, y + 0.48, w, 0.5, 22, C.ink, true);
  body(s, detail, x, y + 1.15, w, 1.35, 17);
}
const pngs = new Map();
function image(s, key, x, y, w, h) {
  const { file, ratio } = pngs.get(key);
  let iw = w, ih = w / ratio;
  if (ih > h) { ih = h; iw = h * ratio; }
  s.addImage({ path: file, x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih });
}
function arrow(s, x, y, w) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color: C.accent, width: 1.5, endArrowType: 'triangle' } });
}

async function build() {
  for (const [key, name] of Object.entries(img)) {
    const file = path.join(assets, name);
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not a PNG: ${file}`);
    pngs.set(key, { file, ratio: bytes.readUInt32BE(16) / bytes.readUInt32BE(20) });
  }
  // 01: lead with the user outcome, not an inspection procedure.
  {
    const s = slide('开场：Yeaft 是跨设备、面向任务的 AI 产品。手机是入口，不是算力所在地；你可以从手机发起复杂工作，由所连接机器上的 Agent 执行。多 VP 是团队，System Prompt 是职责与工作规则，Work Center 让目标跨越单轮对话持续推进。不要把“from anywhere”解释为离线可用：需要能访问 Server，执行 Agent 也必须在线。');
    text(s, 'CROSS-DEVICE · TASK-ORIENTED AI', 0.7, 1.04, 11.7, 0.26, 12, C.accent, true, { charSpacing: 1.3 });
    text(s, 'Your AI team. Real work.\nFrom anywhere.', 0.7, 1.8, 11.65, 1.62, 38, C.ink, true);
    line(s, 0.72, 3.98, 11.85, C.accent, 2);
    body(s, 'Direct complex tasks from your phone.\nLet your AI team work on the machines you connect.', 0.73, 4.5, 11.5, 1.1, 23);
    text(s, 'Multi-VP teams  /  Your system prompts  /  Work Center automation', 0.73, 6.26, 11.9, 0.35, 16, C.accent);
  }
  // 02: name the friction that the product removes.
  {
    const s = slide('先说人的痛点，而不是堆技术名词。提出一个全场贯穿的使用场景：不在电脑旁时，把带验收标准的 bug 修复交给 AI。它是演示建议，不是已完成的客户案例。三类阻力是设备限制、手动协调和逐轮催促。不声称所有竞品都有这些缺点。');
    title(s, 'Why Yeaft', 'Delegate the work—not another round of prompting.', 'Imagine asking from your phone: “Fix this bug, add a regression test, and prepare a reviewed patch.”');
    label(s, 'ACCESS', 'Away from your desk.', 'The code and tools are on another machine. You still need to move the task forward.', 0.73, 3.05, 3.55);
    label(s, 'COORDINATION', 'More than one role.', 'Investigation, implementation, and review need distinct responsibilities.', 4.87, 3.05, 3.55);
    label(s, 'FOLLOW-THROUGH', 'Beyond one reply.', 'Complex work needs execution, checks, recovery, and a clear completion condition.', 9.02, 3.05, 3.55);
    text(s, 'Yeaft brings access, team control, and task execution into one product.', 0.73, 6.42, 11.8, 0.35, 18, C.accent);
  }
  // 03: topology explains why a phone can direct real work.
  {
    const s = slide('讲清手机为什么不只是聊天窗口：浏览器经过 Server 的鉴权和中继，连接用户选择的 Agent。文件、Shell 和模型调用在 Agent 一侧执行，手机不需要运行这些工具。桌面、手机浏览器访问同一 Agent 所属的持久 Session；跨 Agent 不是同一份 Session。Session 和 Work Center 是不同的持久对象，不自动迁移。需要网络可达和在线 Agent。');
    title(s, 'Cross-device execution', 'Your phone is the control surface. The Agent does the work.', 'Use a mobile or desktop browser. Connect the machine that has your project and tools.');
    box(s, 0.73, 3.28, 2.5, 1.55);
    text(s, 'ANY BROWSER', 0.98, 3.52, 2, 0.35, 18, C.ink, true);
    body(s, 'Phone + tablet + desktop', 0.98, 4.1, 2, 0.55, 15);
    arrow(s, 3.3, 4.03, 0.75);
    box(s, 4.14, 3.28, 2.47, 1.55);
    text(s, 'SERVER', 4.38, 3.52, 2, 0.35, 19, C.ink, true);
    body(s, 'Authentication + relay', 4.38, 4.1, 2, 0.55, 15);
    arrow(s, 6.7, 4.03, 0.75);
    box(s, 7.53, 2.95, 5.05, 3.46, C.soft);
    text(s, 'YOUR CONNECTED AGENT', 7.82, 3.18, 4.4, 0.35, 19, C.ink, true);
    text(s, 'Session + multi-VP team', 7.83, 3.87, 4.35, 0.35, 20, C.ink, true);
    body(s, 'Interactive work, with named contributors', 7.83, 4.3, 4.35, 0.4, 15);
    text(s, 'Work Center · Preview', 7.83, 5.02, 4.35, 0.35, 20, C.ink, true);
    body(s, 'Persistent goals and automated execution', 7.83, 5.46, 4.35, 0.4, 15);
    body(s, 'Files, shell, and provider access stay Agent-side.\nRequires a reachable Server and an online Agent.', 0.75, 5.6, 6.4, 0.8, 16);
  }
  // 04: show the real mobile layout, not a decorative phone mockup.
  {
    const s = slide('展示真正的移动端响应式界面，不用手机外框代替能力证明。讲用户动作：选择 Agent 和 Session、发起需求、查看回复、在需要时补充决策。图中为隔离环境的只读语法检查示例，只证明 UI 展示，不声称已在手机上完成 bug 修复或实测了跨公网设备接力。演示时可以打开手机浏览器操作同一 Agent 的 Session。');
    title(s, '01 / Cross-device access', 'Step away from the desk—not from the task.');
    image(s, 'mobile', 0.8, 2.25, 3.5, 4.48);
    text(s, 'START FROM YOUR PHONE', 4.95, 2.77, 7.25, 0.3, 12, C.accent, true);
    text(s, 'The project stays on the Agent.\nThe conversation comes with you.', 4.95, 3.23, 7.25, 1.05, 26, C.ink, true);
    body(s, 'Send the goal. Read named replies.\nAdd direction when the work needs a decision.', 4.95, 4.67, 7.25, 1.0, 20);
    text(s, 'Continue in a desktop browser with the same Agent + Session.', 4.95, 6.11, 7.25, 0.55, 15, C.accent);
    demo(s, 'Mobile viewport');
  }
  // 05: present multi-VP as an adjustable team, not a fixed pipeline.
  {
    const s = slide('VP 是 Virtual Person，不是另一台机器。一个 Session 可以有 1..N 个 VP：从一个助手起步，需要时加入实现、审查、研究等不同角色。用户 mention 可以选中成员；VP 间明确交接需要工具路由。截图中的 Linus 和 Martin 是演示配置，不是每个 Session 都内置的强制流程，也不构成对本 PPT 的真实独立审查。');
    title(s, '02 / Multi-VP teams', 'One workspace. Different minds on the problem.');
    image(s, 'roster', 0.7, 2.37, 8.15, 4.3);
    text(s, 'BUILD', 9.17, 2.92, 3.25, 0.27, 12, C.accent, true);
    body(s, 'Give an implementer a focused responsibility.', 9.17, 3.38, 3.25, 1.05, 20);
    text(s, 'CHALLENGE', 9.17, 4.68, 3.25, 0.27, 12, C.accent, true);
    body(s, 'Let a reviewer question the result—not just echo it.', 9.17, 5.14, 3.25, 1.05, 20);
    demo(s, '1..N VPs per Session');
  }
  // 06: configurable system instructions are a first-class differentiator.
  {
    const s = slide('这是产品差异点，不再把 VP 只讲成两个头像。用户可以配置 VP persona prompt；Project instruction 和工作目录 CLAUDE.md / AGENTS.md 提供共享规则。这里展示的是可配置指令示例，不是 UI 截图或已经实施的强制策略。System Prompt 定义 AI 如何工作，但并非 OS sandbox 或绝对安全保证；运行时权限与工具边界仍独立生效。');
    title(s, '03 / Your system prompts', 'Define how your AI team works.', 'Configure VP personas. Carry shared rules through Project instructions and repository docs.');
    label(s, 'VP PERSONA / EXAMPLE', 'Give the role a contract.', '“Act as an implementer.\nMake the smallest useful change.\nReport tests and open risks.”', 0.78, 3.03, 5.45);
    label(s, 'PROJECT RULES / EXAMPLE', 'Keep standards consistent.', '“Review the exact revision.\nAsk before deployment.\nNever claim an unrun test passed.”', 7.15, 3.03, 5.35);
    line(s, 0.8, 6.13, 11.7, C.accent, 1.5);
    text(s, 'Reusable instructions—not a one-off reminder in every conversation.', 0.8, 6.42, 11.7, 0.37, 18, C.accent);
  }
  // 07: switch from supervising turns to delegating a goal.
  {
    const s = slide('过渡：Session 适合人和 AI 共同探索，Work Center 适合目标明确后的自动化执行。用户交的是目标、约束和验收，而不是每一步 prompt。概念图说明面向任务的使用方式，不暗示所有任务采用固定 VP 顺序、无限重试或自动成功。Work Center 不等于另一种 chat mode，也不是把 Session transcript 自动转换过去。');
    title(s, '04 / Task-oriented automation · Preview', 'Give it a goal—not a script of prompts.', 'Use Session to work with AI. Use Work Center to delegate work to AI.');
    box(s, 0.75, 3.0, 3.35, 2.08);
    text(s, 'YOU DEFINE', 1.02, 3.28, 2.85, 0.4, 22, C.ink, true);
    body(s, 'Goal + constraints\nWorking directory\nAcceptance criteria', 1.02, 3.91, 2.85, 0.95, 16);
    arrow(s, 4.24, 3.85, 1.18);
    box(s, 5.55, 3.0, 3.25, 2.08);
    text(s, 'AI EXECUTES', 5.82, 3.28, 2.73, 0.4, 22, C.ink, true);
    body(s, 'Plan and assign work\nRun tools and checks\nRecord outcomes', 5.82, 3.91, 2.73, 0.95, 16);
    arrow(s, 8.94, 3.85, 1.1);
    text(s, 'YOU CHECK', 10.26, 3.28, 2.3, 0.42, 22, C.ink, true);
    body(s, 'Result + evidence\nOr a specific decision\nthat needs your input', 10.26, 3.91, 2.3, 1.1, 16);
    line(s, 0.8, 5.94, 11.7, C.accent, 1.5);
    text(s, 'Less turn-by-turn supervision. A persistent goal with visible execution.', 0.8, 6.3, 11.7, 0.48, 19, C.accent);
  }
  // 08: evidence supports trust; it is no longer the entire product story.
  {
    const s = slide('工具和文件把“AI 说做了”连接到可查看的实际工作环境。保留用户认可的真实 Files 和 Terminal 组件截图。这里的 terminal 只回放实际 node --check 结果；截图里的语法检查不是 bug 修复证明，也不是完整测试。讲清楚这一句即可，不要把全场重新讲成语法检查教学。');
    title(s, 'Real tools. Visible work.', 'More than a chat window: a working environment.');
    text(s, 'FILES / inspect the actual source', 0.75, 2.35, 5.85, 0.36, 16, C.ink, true);
    text(s, 'TERMINAL / inspect command output', 6.83, 2.35, 5.75, 0.36, 16, C.ink, true);
    image(s, 'files', 0.73, 2.93, 5.85, 3.42);
    image(s, 'terminal', 6.8, 2.93, 5.85, 3.42);
    text(s, 'Stay close to the files the Agent works with.', 0.75, 6.55, 5.8, 0.28, 14, C.muted);
    text(s, 'Example: node --check, not a full test suite.', 6.83, 6.55, 5.75, 0.28, 14, C.accent);
    demo(s, 'Recorded command output');
  }
  // 09: sell continuity first; keep WorkItem/Action/Run as the supporting model.
  {
    const s = slide('展示 Work Center 的实际界面，把它从数据结构介绍变成“任务不是随聊天窗口消失”的价值。WorkItem 持久化目标和验收，Action 是工作单元，Run 是一次执行。在线 Agent 执行不依赖浏览器持续打开；Agent 下线无法继续做事，重启恢复要受状态和副作用安全边界控制。演示 WorkItem 仍是 staged 只读检查，不是已经跑完的复杂自动化案例。');
    title(s, 'Work Center · Preview', 'The task persists beyond the conversation.');
    image(s, 'work', 0.73, 2.4, 8.1, 4.22);
    const nodes = [['KEEP THE GOAL', 'WorkItem: objective and acceptance criteria'], ['FOLLOW THE WORK', 'Action: assigned work and current status'], ['INSPECT THE RESULT', 'Run: execution attempts and evidence']];
    nodes.forEach(([name, detail], i) => {
      const y = 2.86 + i * 1.22;
      text(s, name, 9.15, y, 3.25, 0.3, 13, C.accent, true);
      body(s, detail, 9.15, y + 0.44, 3.25, 0.73, 18);
    });
    demo(s, 'Agent-side execution · Separate from Session');
  }
  // 10: bounded autonomy is a benefit, not an apology page.
  {
    const s = slide('把“纯自动化”说成有边界的目标执行：在目标、权限和验收明确时自动推进，不必逐轮发送继续；缺少用户决策或外部副作用无法确认安全时，应进入 waiting/attention，而不是盲目重试。当前 Work Center 为 Preview。Prompts 和 read 标签都不是沙箱，不能承诺绝对隔离。完成必须经过验收门禁，不能把一次模型回复或一个 Run 结束说成整个任务完成。');
    title(s, 'Autonomy without surrendering control', 'Let AI keep working. Keep the decisions that matter.');
    label(s, 'AUTOMATE', 'Beyond chat turns.', 'Ready work runs on the Agent. Outcomes and bounded retries do not need a fresh prompt each time.', 0.76, 3.03, 3.55);
    label(s, 'INTERVENE', 'Keep key decisions.', 'Review progress. Supply missing input. Resolve blockers or stop the work.', 4.87, 3.03, 3.55);
    label(s, 'ACCEPT', 'Against the goal.', 'Completion depends on acceptance checks—not merely an assistant saying “done”.', 8.99, 3.03, 3.55);
    text(s, 'Within configured tools and permissions. Instructions are not a sandbox.', 0.78, 6.42, 11.7, 0.4, 17, C.accent);
  }
  // 11: summarize the differentiated combination, without invented competitor claims.
  {
    const s = slide('竞争力来自四种能力的组合，不宣称市场唯一，也不做未实测的竞品功能矩阵。让听众记住：移动访问不是缩小的聊天框，多 VP 不是换头像，Prompt 可控不是一次性提醒，Work Center 不是聊天记录归档。这一页用于回收主线，不再重复产品拓扑或只读检查证据。');
    title(s, 'Why this combination matters', 'An AI workspace built around getting work done.', 'Access, team design, behavior control, and automation belong together.');
    const rows = [
      ['CROSS-DEVICE', 'Direct real Agent-side work from a phone or desktop.'],
      ['MULTI-VP', 'Split responsibilities while keeping contributions visible.'],
      ['SYSTEM PROMPTS', 'Shape reusable roles and shared working rules.'],
      ['WORK CENTER', 'Delegate persistent goals, not just individual replies.'],
    ];
    rows.forEach(([name, value], i) => {
      const y = 2.95 + i * 0.76;
      text(s, name, 0.77, y, 2.4, 0.32, 12, C.accent, true);
      text(s, value, 3.25, y - 0.02, 9.28, 0.44, 18, C.ink);
      if (i !== rows.length - 1) line(s, 0.77, y + 0.59, 11.77, C.line, 0.6);
    });
    text(s, 'A phone-sized entry point. A task-sized ambition.', 0.77, 6.46, 11.7, 0.4, 22, C.accent, true);
  }
  // 12: leave with an actionable trial, not another feature catalogue.
  {
    const s = slide('收尾：建议现场从手机打开已连接 Agent 的 Session，给一个边界清晰的任务，展示角色和规则，再去 Work Center 创建带验收标准的目标。建议试用任务为修复一个小 bug、加一个回归测试、准备待审查 patch；它是试用建议，不是本稿声称已完成的结果。先按 README 配置，不默认授权自动部署。');
    title(s, 'Try Yeaft', 'Your next task does not have to wait for your desk.');
    label(s, '01', 'Connect your machine.', 'Run an Agent where your project and tools already live.', 0.78, 3.02, 3.5);
    label(s, '02', 'Shape your AI team.', 'Choose VPs. Define their roles and your project rules.', 4.9, 3.02, 3.5);
    label(s, '03', 'Delegate a real goal.', 'Start from your phone. Give Work Center a bounded task and clear acceptance criteria.', 9.01, 3.02, 3.5);
    line(s, 0.78, 6.0, 11.7, C.accent, 1.5);
    text(s, 'Start here → github.com/yeaft/yeaft-web-code-agent', 0.78, 6.35, 11.7, 0.45, 21, C.accent, true, { hyperlink: { url: 'https://github.com/yeaft/yeaft-web-code-agent#readme' } });
  }
  const deckPath = path.join(outDir, 'yeaft-editorial-minimal.pptx');
  await pptx.writeFile({ fileName: deckPath });
  const archive = new JSZip();
  archive.file(path.basename(deckPath), await fs.readFile(deckPath));
  for (const name of Object.values(img)) archive.file(`assets/${name}`, await fs.readFile(path.join(assets, name)));
  for (const name of ['assets/capture-manifest.json', 'README.md', 'showcase-talk-track.md']) archive.file(name, await fs.readFile(path.join(outDir, name)));
  await fs.writeFile(path.join(outDir, 'yeaft-editorial-minimal-package.zip'), await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
