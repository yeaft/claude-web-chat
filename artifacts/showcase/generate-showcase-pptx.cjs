const pptxgen = require('/tmp/yeaft-pptx-tools/node_modules/pptxgenjs');
const path = require('path');

const outDir = __dirname;
const assets = path.join(outDir, 'assets');
const img = {
  home: path.join(assets, '01-home.png'),
  conversation: path.join(assets, '04-session-conversation.png'),
  roster: path.join(assets, '05-session-roster.png'),
  workbenchFiles: path.join(assets, '08-workbench-files-correct.png'),
  workbenchTerminal: path.join(assets, '08-workbench-terminal-correct.png'),
  workStructure: path.join(assets, '09-work-center-structure.png'),
};

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Yeaft';
pptx.company = 'Yeaft';
pptx.subject = 'Yeaft product overview';
pptx.title = 'Yeaft — AI Engineering Workstation';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };
pptx.defineSlideMaster({
  title: 'MINIMAL',
  background: { color: 'F4F1EA' },
  objects: [
    { text: { text: 'YEAFT', options: { x: 0.56, y: 0.28, w: 0.85, h: 0.18, fontSize: 8, bold: true, color: '1D1D1B', charSpacing: 2.1, margin: 0 } } },
    { line: { x: 0.56, y: 0.57, w: 12.2, h: 0, line: { color: 'D7D2C8', width: 0.7 } } },
  ],
  slideNumber: { x: 12.25, y: 7.08, w: 0.5, h: 0.16, fontSize: 7, color: '9297A1', align: 'right', margin: 0 },
});

const C = {
  bg: 'F4F1EA', paper: 'FFFFFF', ink: '1D1D1B', muted: '686761', dim: '96938B',
  line: 'D7D2C8', soft: 'ECE8DF', blue: '8B5E3C', paleBlue: 'E9E2D8', dark: '1D1D1B', white: 'FFFFFF'
};

function addText(s, text, x, y, w, h, size, color = C.ink, bold = false, extra = {}) {
  s.addText(text, { x, y, w, h, fontSize: size, color, bold, margin: 0, breakLine: false, ...extra });
}
function eyebrow(s, text, x = 0.62, y = 0.8, w = 4.5) {
  addText(s, text.toUpperCase(), x, y, w, 0.2, 8, C.muted, true, { charSpacing: 1.5 });
}
function headline(s, text, x = 0.62, y = 1.17, w = 10.8, h = 0.74, size = 27) {
  addText(s, text, x, y, w, h, size, C.ink, true, { fit: 'shrink' });
}
function body(s, text, x, y, w, h, size = 11, color = C.muted, extra = {}) {
  addText(s, text, x, y, w, h, size, color, false, { fit: 'shrink', valign: 'top', paraSpaceAfterPt: 4, ...extra });
}
function sectionTitle(s, label, title, subline) {
  eyebrow(s, label);
  headline(s, title);
  if (subline) body(s, subline, 0.62, 1.91, 10.6, 0.44, 10.5);
}
function containAspect(x, y, w, h, ratio) {
  let iw = w, ih = iw / ratio;
  if (ih > h) { ih = h; iw = ih * ratio; }
  return { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
}
function imageFrame(s, file, x, y, w, h, ratio) {
  const box = containAspect(x, y, w, h, ratio);
  s.addImage({ path: file, ...box });
  s.addShape(pptx.ShapeType.rect, { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: C.paper, transparency: 100 }, line: { color: C.line, width: 0.55 } });
}
function rule(s, x, y, w, color = C.line, width = 1) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width } });
}
function tag(s, text, x, y, w) {
  rule(s, x, y, 0.32, C.blue, 1.4);
  addText(s, text, x + 0.45, y - 0.055, w - 0.45, 0.16, 7, C.muted, true, { charSpacing: 0.5 });
}
function metric(s, value, label, x, y, w) {
  addText(s, value, x, y, w, 0.62, 34, C.ink, true);
  rule(s, x, y + 0.75, w, C.blue, 2);
  body(s, label, x, y + 0.91, w, 0.58, 9.5);
}
function simpleCard(s, number, title, text, x, y, w, h) {
  addText(s, number, x, y, 0.45, 0.22, 8, C.blue, true);
  addText(s, title, x, y + 0.38, w, 0.3, 15, C.ink, true, { fit: 'shrink' });
  body(s, text, x, y + 0.88, w, h - 0.88, 9.5);
}
function footer(s, text) {
  addText(s, text, 0.58, 7.08, 8.5, 0.14, 6, C.dim);
}

// 01 — cover: one restrained product image
{
  const s = pptx.addSlide('MINIMAL');
  eyebrow(s, 'Product overview · 2026', 0.66, 1.02);
  headline(s, 'The AI engineering\nworkstation.', 0.66, 1.48, 5.0, 1.42, 34);
  body(s, 'One continuous environment for conversation, specialist collaboration, development tools, review, and durable execution.', 0.68, 3.18, 4.55, 1.02, 12, C.muted);
  tag(s, 'ONE TASK · ONE TEAM · ONE FLOW', 0.68, 4.55, 2.65);
  imageFrame(s, img.home, 5.65, 1.0, 6.65, 5.38, 16 / 9);
  footer(s, 'Real Yeaft Web UI · Staged demonstration data');
}

// 02 — problem: typography only
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'The problem', 'AI can answer quickly. Engineering still breaks between the answers.', 'The real cost appears in handoffs, missing context, unverifiable claims, and work that stops when a chat turn ends.');
  const items = [
    ['01', 'Context fragments', 'Work is reconstructed across devices, chats, terminals, and review tools.'],
    ['02', 'Ownership blurs', 'It becomes unclear who implemented, who reviewed, and what happens next.'],
    ['03', 'Evidence disappears', 'The answer survives; the exact files, commands, diffs, and outcomes do not.'],
    ['04', 'Momentum resets', 'Longer goals lose durable state, attempts, dependencies, and acceptance checks.'],
  ];
  items.forEach((v, i) => simpleCard(s, v[0], v[1], v[2], 0.7 + i * 3.08, 2.85, 2.45, 2.35));
  rule(s, 0.7, 5.66, 11.62, C.line, 1);
  addText(s, 'The missing product is continuity.', 0.7, 5.98, 7.5, 0.48, 22, C.ink, true);
}

// 03 — flow: diagram only
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'The Yeaft idea', 'Keep one task identity while the work changes form.', 'Devices, specialists, tools, and timescales can change without breaking the engineering story.');
  const steps = [
    ['01', 'Respond', 'from anywhere'], ['02', 'Assign', 'the right specialist'], ['03', 'Build', 'in the workspace'],
    ['04', 'Review', 'independently'], ['05', 'Continue', 'until accepted']
  ];
  rule(s, 1.05, 4.0, 10.65, C.line, 1.3);
  steps.forEach((v, i) => {
    const x = 0.72 + i * 2.48;
    s.addShape(pptx.ShapeType.rect, { x: x + 0.47, y: 3.88, w: 0.24, h: 0.24, fill: { color: i === 0 || i === 4 ? C.blue : C.paper }, line: { color: C.blue, width: 1.1 } });
    addText(s, v[0], x + 0.21, 3.4, 0.76, 0.12, 7, C.muted, true, { align: 'center' });
    addText(s, v[1], x, 4.56, 1.55, 0.24, 13, C.ink, true, { align: 'center' });
    body(s, v[2], x, 4.94, 1.55, 0.4, 8.7, C.muted, { align: 'center' });
  });
  tag(s, 'ONE SHARED CONTEXT', 5.24, 5.92, 1.85);
}

// 04 — access anywhere: screenshot earns its place
{
  const s = pptx.addSlide('MINIMAL');
  eyebrow(s, 'Feature 01 · Access anywhere', 0.66, 1.02);
  headline(s, 'Leave the desk.\nKeep the context.', 0.66, 1.52, 4.5, 1.15, 30);
  body(s, 'Open the same Session from another device. Inspect progress, answer a blocker, and provide the next instruction without rebuilding the task.', 0.68, 2.99, 4.15, 1.2, 11.2);
  const points = ['Same Session', 'Same project context', 'Same connected Agent'];
  points.forEach((t, i) => {
    addText(s, `0${i + 1}`, 0.68, 4.65 + i * 0.52, 0.35, 0.17, 7.5, C.blue, true);
    addText(s, t, 1.18, 4.61 + i * 0.52, 3.2, 0.24, 11, C.ink, true);
  });
  imageFrame(s, img.conversation, 5.28, 0.98, 7.1, 5.65, 1540 / 1300);
}

// 05 — Session: screenshot + concise annotations
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'Feature 02 · Shared Session', 'One conversation. One goal. A visible team.', 'The Session is the collaboration boundary—not another disconnected chat mode.');
  imageFrame(s, img.roster, 0.68, 2.72, 7.25, 3.8, 980 / 1345);
  const notes = [
    ['CONVERSATION', 'A continuous narrative'],
    ['ROSTER', '1..N Virtual Persons'],
    ['CONTEXT', 'Project stays attached'],
    ['OWNERSHIP', 'Results stay attributable'],
  ];
  notes.forEach((v, i) => {
    const y = 2.82 + i * 0.9;
    addText(s, v[0], 8.45, y, 1.25, 0.16, 7.3, C.blue, true, { charSpacing: 0.8 });
    addText(s, v[1], 9.83, y - 0.03, 2.4, 0.23, 11, C.ink, true, { fit: 'shrink' });
    if (i < 3) rule(s, 8.45, y + 0.48, 3.78, C.line, 0.7);
  });
}

// 06 — VP model: no screenshot
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'Feature 03 · Virtual Persons', 'Not more chatbots. A separation of duties.', 'Distinct judgment, skills, and responsibility applied to one shared engineering outcome.');
  metric(s, '30+', 'specialized Virtual Persons available to join a Session', 0.75, 2.92, 2.5);
  metric(s, '1', 'shared Session keeps the active goal coherent', 3.8, 2.92, 2.5);
  metric(s, 'N', 'specialists contribute where responsibility is clear', 6.85, 2.92, 2.5);
  metric(s, '✓', 'attributable output preserves accountability', 9.9, 2.92, 2.5);
  addText(s, 'Specialization matters only when the boundaries are explicit.', 0.75, 5.55, 10.7, 0.48, 20, C.ink, true);
}

// 07 — handoff: diagram only
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'Collaboration in practice', 'Implementation and review are different jobs.', 'Explicit routing turns multiple specialists into an accountable team.');
  simpleCard(s, '01', 'LINUS · BUILD', 'Investigate the root cause. Make the smallest correct change. Record concrete verification.', 0.95, 3.0, 3.2, 1.9);
  simpleCard(s, '02', 'MARTIN · REVIEW', 'Check the exact revision, full diff, regression risk, and delivery state independently.', 9.18, 3.0, 3.2, 1.9);
  rule(s, 4.38, 3.78, 4.55, C.blue, 1.8);
  s.addShape(pptx.ShapeType.chevron, { x: 8.62, y: 3.58, w: 0.42, h: 0.42, fill: { color: C.blue }, line: { color: C.blue } });
  tag(s, 'EXPLICIT HANDOFF', 5.78, 3.28, 1.72);
  addText(s, 'BLOCKER', 5.08, 4.4, 1.0, 0.18, 8, C.muted, true, { align: 'center' });
  addText(s, 'APPROVE', 7.18, 4.4, 1.0, 0.18, 8, C.blue, true, { align: 'center' });
  body(s, 'Sender, recipient, reason, exact result, and next responsibility remain visible.', 3.84, 5.48, 5.65, 0.42, 10, C.muted, { align: 'center' });
}

// 08 — Workbench: two relevant screenshot details
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'Feature 04 · Workbench', 'Browse the project. Open a terminal. Verify the work.', 'The engineering environment remains beside the Session instead of disappearing behind an answer.');
  imageFrame(s, img.workbenchFiles, 0.68, 2.55, 5.88, 3.68, 16 / 10);
  imageFrame(s, img.workbenchTerminal, 6.77, 2.55, 5.88, 3.68, 16 / 10);
  addText(s, 'FILES', 0.7, 6.4, 0.55, 0.16, 7.5, C.muted, true, { charSpacing: 0.9 });
  body(s, 'Project tree · open file · code editor', 1.34, 6.36, 4.8, 0.3, 8.8);
  addText(s, 'TERMINAL', 6.79, 6.4, 0.9, 0.16, 7.5, C.muted, true, { charSpacing: 0.9 });
  body(s, 'Shell prompt · command · verification output', 7.82, 6.36, 4.5, 0.3, 8.8);
}

// 09 — Work Center: one supporting screenshot
{
  const s = pptx.addSlide('MINIMAL');
  eyebrow(s, 'Feature 05 · Work Center · Preview', 0.66, 0.92);
  headline(s, 'Longer goals need\ndurable structure.', 0.66, 1.35, 4.3, 1.2, 30);
  body(s, 'Work Center preserves the objective, execution graph, attempts, and acceptance evidence beyond one chat turn.', 0.68, 2.93, 3.95, 0.98, 11.2);
  const nodes = [['WORKITEM', 'Goal + acceptance criteria'], ['ACTION', 'Concrete unit of work'], ['RUN', 'One durable attempt']];
  nodes.forEach((v, i) => {
    const y = 4.26 + i * 0.66;
    addText(s, `0${i + 1}`, 0.7, y, 0.35, 0.17, 7.5, C.blue, true);
    addText(s, v[0], 1.15, y - 0.02, 1.05, 0.2, 9.5, C.ink, true);
    body(s, v[1], 2.25, y - 0.03, 2.2, 0.24, 8.7);
  });
  imageFrame(s, img.workStructure, 5.05, 1.0, 7.35, 5.75, 1910 / 1335);
}

// 10 — autonomy principles: no screenshot
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'Controlled autonomy', 'Keep moving—without hiding how.', 'Autonomy is useful only when progress, conflicts, failed attempts, and acceptance checks remain inspectable.');
  const principles = [
    ['01', 'Durable', 'Status survives beyond one response.'],
    ['02', 'Dependency-aware', 'Actions consume real results, not ceremonial phases.'],
    ['03', 'Conflict-aware', 'Unsafe workspace writes remain controlled.'],
    ['04', 'Evidence-gated', 'Completion requires outcomes and acceptance checks.'],
  ];
  principles.forEach((v, i) => simpleCard(s, v[0], v[1], v[2], 0.72 + i * 3.05, 3.08, 2.42, 1.75));
  s.addShape(pptx.ShapeType.rect, { x: 4.34, y: 5.72, w: 4.65, h: 0.58, fill: { color: C.dark }, line: { color: C.dark } });
  addText(s, 'PERSISTENT  ≠  UNBOUNDED', 4.57, 5.92, 4.18, 0.16, 9, C.white, true, { align: 'center', charSpacing: 0.8 });
}

// 11 — complete story: typography/timeline only
{
  const s = pptx.addSlide('MINIMAL');
  sectionTitle(s, 'A complete user story', 'One production issue. Six accountable moments.', 'The product becomes valuable when the features behave as one continuous engineering experience.');
  const story = [
    ['01', 'Respond', 'Answer the blocker'], ['02', 'Implement', 'Change what is necessary'], ['03', 'Review', 'Check the exact revision'],
    ['04', 'Verify', 'Expose command and Git evidence'], ['05', 'Continue', 'Preserve Actions and Runs'], ['06', 'Deliver', 'Advance on acceptance evidence']
  ];
  rule(s, 0.98, 4.0, 11.18, C.line, 1.2);
  story.forEach((v, i) => {
    const x = 0.62 + i * 2.07;
    s.addShape(pptx.ShapeType.rect, { x: x + 0.36, y: 3.89, w: 0.22, h: 0.22, fill: { color: i === 5 ? C.blue : C.paper }, line: { color: C.blue, width: 1.1 } });
    addText(s, v[0], x + 0.1, 3.42, 0.72, 0.1, 6.8, C.muted, true, { align: 'center' });
    addText(s, v[1], x, 4.55, 1.55, 0.22, 11.5, C.ink, true, { align: 'center' });
    body(s, v[2], x, 4.95, 1.55, 0.55, 8.2, C.muted, { align: 'center' });
  });
  addText(s, 'The task never loses its identity.', 2.55, 5.95, 8.2, 0.5, 22, C.ink, true, { align: 'center' });
}

// 12 — finish: pure typography
{
  const s = pptx.addSlide('MINIMAL');
  eyebrow(s, 'The outcome', 0.68, 1.18);
  headline(s, 'One place to move engineering\nfrom request to verified outcome.', 0.68, 1.68, 10.8, 1.45, 34);
  rule(s, 0.7, 3.68, 11.55, C.blue, 2.2);
  const columns = [
    ['ANYWHERE', 'Resume the same Session without reconstructing context.'],
    ['AS A TEAM', 'Apply explicit roles and independent judgment.'],
    ['TO OUTCOME', 'Connect tools, evidence, and durable execution.'],
  ];
  columns.forEach((v, i) => {
    const x = 0.72 + i * 4.08;
    addText(s, v[0], x, 4.2, 2.7, 0.2, 8, C.blue, true, { charSpacing: 1.1 });
    body(s, v[1], x, 4.72, 3.25, 0.75, 11, C.ink);
  });
  addText(s, 'YEAFT', 0.72, 6.32, 1.2, 0.25, 13, C.ink, true, { charSpacing: 2.2 });
  footer(s, 'Work Center is a Preview capability.');
}

pptx.writeFile({ fileName: path.join(outDir, 'yeaft-editorial-minimal.pptx') });
