const pptxgen = require('pptxgenjs');
const JSZip = require('jszip');
const fs = require('node:fs/promises');
const path = require('node:path');

const outDir = __dirname;
const assets = path.join(outDir, 'assets');
const img = {
  home: '01-home.png',
  conversation: '04-session-conversation.png',
  roster: '05-session-roster.png',
  files: '08-workbench-files-correct.png',
  terminal: '08-workbench-terminal-correct.png',
  work: '09-work-center-structure.png',
};
const C = { bg: 'F4F1EA', paper: 'FFFFFF', ink: '1D1D1B', muted: '686761', line: 'D7D2C8', accent: '8B5E3C', soft: 'E9E2D8' };
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Yeaft';
pptx.subject = 'From a request to an inspectable engineering result';
pptx.title = 'Yeaft — From request to evidence';
pptx.lang = 'en-US';
// Available in the isolated renderer as well as freely installable on viewer machines.
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
function arrow(s, x, y, w, reverse = false) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color: C.accent, width: 1.5, ...(reverse ? { beginArrowType: 'triangle' } : { endArrowType: 'triangle' }) } });
}

async function build() {
  for (const [key, name] of Object.entries(img)) {
    const file = path.join(assets, name);
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Not a PNG: ${file}`);
    pngs.set(key, { file, ratio: bytes.readUInt32BE(16) / bytes.readUInt32BE(20) });
  }
  // 01: promise, not a second feature list.
  {
    const s = slide('Audience: engineers seeing Yeaft for the first time. The central promise is inspectability, not guaranteed autonomous success. All UI data in this deck is staged; the inspection command is captured by the screenshot script.');
    text(s, 'FROM REQUEST TO EVIDENCE', 0.7, 1.04, 11.7, 0.26, 12, C.accent, true, { charSpacing: 1.3 });
    text(s, 'An answer is a start.\nShow the engineering behind it.', 0.7, 1.8, 11.65, 1.62, 38, C.ink, true);
    line(s, 0.72, 3.98, 11.85, C.accent, 2);
    body(s, 'Yeaft connects a browser workspace to your local Agent—\nwith visible conversations, specialists, files, and terminal output.', 0.73, 4.5, 10.95, 1.1, 23);
    text(s, 'A product walkthrough for engineers', 0.73, 6.26, 10, 0.3, 14, C.muted);
  }
  // 02: three concrete questions establish the evaluation criteria.
  {
    const s = slide('Frame these as questions a team needs to answer, not claims that competing tools always lose context or evidence.');
    title(s, 'The problem', 'A useful answer still leaves three questions.');
    label(s, '01 / CONTEXT', 'What was requested?', 'The goal and constraints need to remain close to the response.', 0.73, 3.05, 3.55);
    label(s, '02 / RESPONSIBILITY', 'Who did what?', 'Implementation and independent judgment are different contributions.', 4.87, 3.05, 3.55);
    label(s, '03 / EVIDENCE', 'What can I check?', 'A file, a command, and a scoped result are stronger than “done”.', 9.02, 3.05, 3.55);
    text(s, 'This walkthrough follows one small inspection—not a claimed production fix.', 0.73, 6.42, 11.8, 0.35, 16, C.accent);
  }
  // 03: topology only; deliberately not a workflow timeline.
  {
    const s = slide('Browser connects through Server authentication and relay to a local Agent. Session is the conversation unit with 1..N VPs. Work Center has its own WorkItems/Actions/Runs and storage; this is not a shared task identity or automatic Session migration.');
    title(s, 'Product map', 'The browser is the workspace. The Agent does the work.', 'Two execution responsibilities live on the Agent. They are not two names for the same conversation.');
    box(s, 0.73, 3.28, 2.5, 1.55);
    text(s, 'BROWSER', 0.98, 3.52, 2, 0.35, 19, C.ink, true);
    body(s, 'Conversation + workbench', 0.98, 4.1, 2, 0.55, 15);
    arrow(s, 3.3, 4.03, 0.75);
    box(s, 4.14, 3.28, 2.47, 1.55);
    text(s, 'SERVER', 4.38, 3.52, 2, 0.35, 19, C.ink, true);
    body(s, 'Authentication + relay', 4.38, 4.1, 2, 0.55, 15);
    arrow(s, 6.7, 4.03, 0.75);
    box(s, 7.53, 2.95, 5.05, 3.46, C.soft);
    text(s, 'LOCAL AGENT', 7.82, 3.18, 4.4, 0.35, 19, C.ink, true);
    text(s, 'Session', 7.83, 3.87, 4.35, 0.35, 20, C.ink, true);
    body(s, 'Conversation with 1..N Virtual Persons', 7.83, 4.3, 4.35, 0.4, 15);
    text(s, 'Work Center · Preview', 7.83, 5.02, 4.35, 0.35, 20, C.ink, true);
    body(s, 'Durable goals, Actions, and Runs', 7.83, 5.46, 4.35, 0.4, 15);
    body(s, 'Files, shell, and provider access stay Agent-side.', 0.75, 5.6, 6.4, 0.7, 16);
  }
  // 04: the request and response shown here are the beginning of one recurring example.
  {
    const s = slide('Example throughout slides 4–11: inspect agent/yeaft/session.js and run node --check. This is a read-only syntax inspection, not a code change, integration test, approved patch, or production delivery. Screenshot must show the user request and corresponding named response.');
    title(s, '01 / Keep the request visible', 'Start with a question you can actually verify.');
    image(s, 'conversation', 0.7, 2.35, 8.15, 4.3);
    text(s, 'REQUEST', 9.17, 2.8, 3.25, 0.25, 12, C.accent, true);
    text(s, 'Inspect Session startup.', 9.17, 3.23, 3.25, 0.75, 23, C.ink, true);
    text(s, 'RESPONSE', 9.17, 4.35, 3.25, 0.25, 12, C.accent, true);
    body(s, 'A named reply links the file and check back to that request.', 9.17, 4.8, 3.25, 1.45, 18);
    demo(s);
  }
  // 05: attribution, not another taxonomy of roles.
  {
    const s = slide('The screenshot must show both a roster and readable named contributions. The demonstration is not evidence that these VPs performed a real independent review of this presentation.');
    title(s, '02 / Make contributions attributable', 'See the team—and what each person contributed.');
    image(s, 'roster', 0.7, 2.37, 8.15, 4.3);
    text(s, 'LINUS', 9.17, 2.92, 3.25, 0.27, 12, C.accent, true);
    body(s, 'Reports the inspected file and syntax result.', 9.17, 3.38, 3.25, 1.05, 20);
    text(s, 'MARTIN', 9.17, 4.68, 3.25, 0.27, 12, C.accent, true);
    body(s, 'Challenges the scope: syntax is not behavior.', 9.17, 5.14, 3.25, 1.05, 20);
    demo(s);
  }
  // 06: role contracts, not unsupported catalogue counts.
  {
    const s = slide('A configurable collaboration example. Linus and Martin illustrate separate responsibilities, not a fixed product workflow or a claim that multiple VPs automatically guarantee independent review.');
    title(s, '03 / Separate responsibilities', 'Give each specialist a different job.', 'Example team configuration—not a fixed sequence built into every Session.');
    label(s, 'IMPLEMENTER / LINUS', 'Produce evidence.', 'Inspect the relevant source.\nRun the bounded check.\nState exactly what it proves.', 0.78, 3.03, 5.45);
    label(s, 'REVIEWER / MARTIN', 'Challenge the claim.', 'Read the same revision.\nCheck the evidence and its limits.\nReturn approval or a specific blocker.', 7.15, 3.03, 5.35);
    line(s, 0.8, 6.13, 11.7, C.accent, 1.5);
    text(s, 'For this example: parsing successfully does not prove Session startup works.', 0.8, 6.42, 11.7, 0.37, 17, C.accent);
  }
  // 07: the only process diagram in the deck, with an explicit return path.
  {
    const s = slide('Explicit routing transfers responsibility. These are recommended review handoff fields, not an automatic runtime proof that a reviewer is independent. Real approval for this deck belongs in the PR audit, not this staged walkthrough.');
    title(s, '04 / Hand over something reviewable', 'Route the revision and evidence—not just “please review”.');
    box(s, 0.75, 3.0, 3.35, 2.08);
    text(s, 'IMPLEMENT', 1.02, 3.28, 2.85, 0.4, 22, C.ink, true);
    body(s, 'File + exact revision\nCommand + exit result\nKnown limitations', 1.02, 3.91, 2.85, 0.95, 16);
    arrow(s, 4.24, 3.85, 1.18);
    box(s, 5.55, 3.0, 3.25, 2.08);
    text(s, 'REVIEW', 5.82, 3.28, 2.73, 0.4, 22, C.ink, true);
    body(s, 'Check the same revision.\nTest the claim against\nthe acceptance criteria.', 5.82, 3.91, 2.73, 0.95, 16);
    arrow(s, 8.94, 3.85, 1.1);
    text(s, 'APPROVE', 9.02, 3.23, 1.22, 0.24, 11, C.accent, true);
    text(s, 'DELIVER', 10.26, 3.62, 2.3, 0.42, 23, C.ink, true);
    body(s, 'Only the reviewed result', 10.26, 4.2, 2.27, 0.65, 15);
    arrow(s, 2.44, 5.75, 4.7, true);
    text(s, 'BLOCKER → CORRECT THE WORK → REVIEW AGAIN', 2.5, 6.02, 6.6, 0.3, 13, C.accent, true);
  }
  // 08: actual component crops, not a recreation of editor/terminal chrome.
  {
    const s = slide('Real Files and Terminal components from the screenshot manifest source revision. Transport is staged. Terminal output replays the actual local syntax check collected by the script. The syntax command does not verify runtime behavior.');
    title(s, '05 / Inspect the workspace', 'Open the source. Read the command and its result.');
    text(s, 'FILES / agent/yeaft/session.js', 0.75, 2.35, 5.85, 0.36, 16, C.ink, true);
    text(s, 'TERMINAL / syntax check', 6.83, 2.35, 5.75, 0.36, 16, C.ink, true);
    image(s, 'files', 0.73, 2.93, 5.85, 3.42);
    image(s, 'terminal', 6.8, 2.93, 5.85, 3.42);
    text(s, 'Visible path + real source', 0.75, 6.55, 5.8, 0.28, 14, C.muted);
    text(s, 'node --check ≠ a behavioral test', 6.83, 6.55, 5.75, 0.28, 14, C.accent);
    demo(s, 'Recorded command output');
  }
  // 09: distinct durable objects, no promise of automatic Session conversion.
  {
    const s = slide('Work Center is a separate durable execution system. This staged WorkItem continues the inspection scenario as an example of an explicitly created long-running goal; no automatic transfer of Session identity, shared transcript, or guaranteed successful completion is implied.');
    title(s, '06 / Preserve longer work · Preview', 'When the goal outlasts a conversation, record it as work.');
    image(s, 'work', 0.73, 2.4, 8.1, 4.22);
    const nodes = [['WORKITEM', 'The goal and acceptance criteria'], ['ACTION', 'A concrete unit of work'], ['RUN', 'One execution attempt and result']];
    nodes.forEach(([name, detail], i) => {
      const y = 2.86 + i * 1.22;
      text(s, name, 9.15, y, 3.25, 0.3, 13, C.accent, true);
      body(s, detail, 9.15, y + 0.44, 3.25, 0.65, 18);
    });
    demo(s, 'Separate from Session history');
  }
  // 10: explicit limitations replace broad safety/autonomy marketing promises.
  {
    const s = slide('Scheduling has dependency/workspace conflict constraints, but read mode is not a sandbox: it does not filter write tools. No promise of complete isolation or success. The example syntax check has not satisfied behavioral acceptance criteria.');
    title(s, 'The boundary', 'Progress is useful only when its limits are visible.');
    label(s, 'COORDINATION', 'Check prerequisites.', 'Results and workspace conflicts affect what can run next. A “read” label is not a sandbox.', 0.76, 3.03, 3.55);
    label(s, 'STOPPING', 'Expose the blocker.', 'Missing evidence, failure, or a required decision must not be reported as success.', 4.87, 3.03, 3.55);
    label(s, 'ACCEPTANCE', 'Verify the goal.', 'The inspection passed syntax. Startup behavior remains untested; that limit stays visible.', 8.99, 3.03, 3.55);
    text(s, 'A finished response is not proof of a finished engineering task.', 0.78, 6.42, 11.7, 0.36, 20, C.accent, true);
  }
  // 11: a concrete evidence ledger, not a duplicate journey diagram.
  {
    const s = slide('This is the inspection example handoff, not the release evidence for this presentation. No source was changed by the example. Actual capture revision and command exit status are recorded in assets/capture-manifest.json; staged reviewer text is not independent PR approval.');
    title(s, 'The handoff', 'What can the next engineer check?', 'Inspection example: keep the result narrow enough to be true.');
    const rows = [
      ['SOURCE', 'agent/yeaft/session.js · inspected, not modified'],
      ['REVISION', 'Exact UI/source commit recorded in capture-manifest.json'],
      ['COMMAND', 'node --check agent/yeaft/session.js · recorded exit result'],
      ['REVIEW', 'Demo reviewer challenges scope · not a real PR approval'],
      ['ACCEPTANCE', 'Syntax check only · startup behavior remains untested'],
      ['RISK / NEXT STEP', 'No runtime claim · add a startup test before changing behavior'],
    ];
    rows.forEach(([name, value], i) => {
      const y = 2.9 + i * 0.62;
      text(s, name, 0.77, y, 2.2, 0.32, 11, C.accent, true);
      text(s, value, 3.0, y - 0.02, 9.53, 0.4, 16, C.ink);
      if (i !== rows.length - 1) line(s, 0.77, y + 0.49, 11.77, C.line, 0.6);
    });
    text(s, 'Staged walkthrough · Actual presentation validation is documented separately', 0.77, 7.03, 11.1, 0.28, 10, C.muted);
  }
  // 12: one action, one valid link.
  {
    const s = slide('Single entry point is the canonical repository README, which contains current setup instructions. This link is independent of any locally running server or demo credentials.');
    title(s, 'Try it with a small, bounded task', 'Bring one question. Leave with something you can check.');
    label(s, '01', 'Connect an Agent.', 'Follow the setup guide for your local environment.', 0.78, 3.02, 3.5);
    label(s, '02', 'Open a Session.', 'Ask a concrete question about one file or behavior.', 4.9, 3.02, 3.5);
    label(s, '03', 'Inspect the evidence.', 'Read the source, command result, and remaining limitations.', 9.01, 3.02, 3.5);
    line(s, 0.78, 6.0, 11.7, C.accent, 1.5);
    text(s, 'Start here → github.com/yeaft/yeaft-web-code-agent', 0.78, 6.35, 11.7, 0.45, 21, C.accent, true, { hyperlink: { url: 'https://github.com/yeaft/yeaft-web-code-agent#readme' } });
  }
  const deckPath = path.join(outDir, 'yeaft-editorial-minimal.pptx');
  await pptx.writeFile({ fileName: deckPath });
  const archive = new JSZip();
  archive.file(path.basename(deckPath), await fs.readFile(deckPath));
  for (const name of Object.values(img)) archive.file(`assets/${name}`, await fs.readFile(path.join(assets, name)));
  // A missing capture manifest or guide must fail the deliverable build, not silently ship stale evidence.
  for (const name of ['assets/capture-manifest.json', 'README.md']) archive.file(name, await fs.readFile(path.join(outDir, name)));
  await fs.writeFile(path.join(outDir, 'yeaft-editorial-minimal-package.zip'), await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
