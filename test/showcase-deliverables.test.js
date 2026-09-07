import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../artifacts/showcase/', import.meta.url));
const read = name => readFile(`${root}${name}`);
const slideText = xml => [...xml.matchAll(/<a:t>(.*?)<\/a:t>/gs)].map(match => match[1]).join(' ');

describe('showcase deliverable contract', () => {
  it('ships the same presentation and current evidence assets in the ZIP', async () => {
    const deck = await read('yeaft-editorial-minimal.pptx');
    const archive = await JSZip.loadAsync(await read('yeaft-editorial-minimal-package.zip'));
    expect(await archive.file('yeaft-editorial-minimal.pptx').async('nodebuffer')).toEqual(deck);
    for (const name of ['README.md', 'showcase-talk-track.md', 'assets/capture-manifest.json', 'assets/01-home.png', 'assets/04-session-mobile.png', 'assets/04-session-conversation.png', 'assets/05-session-roster.png', 'assets/08-workbench-files-correct.png', 'assets/08-workbench-terminal-correct.png', 'assets/09-work-center-structure.png']) {
      expect(await archive.file(name).async('nodebuffer')).toEqual(await read(name));
    }
  });

  it('leads with cross-device task execution, configurable teams, and bounded autonomy', async () => {
    const deck = await JSZip.loadAsync(await read('yeaft-editorial-minimal.pptx'));
    const names = Object.keys(deck.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(names).toHaveLength(12);
    const text = async n => slideText(await deck.file(`ppt/slides/slide${n}.xml`).async('string'));
    expect(await text(1)).toContain('Your AI team. Real work.');
    expect(await text(3)).toContain('Authentication + relay');
    expect(await text(3)).toContain('online Agent');
    expect(await text(4)).toContain('START FROM YOUR PHONE');
    expect(await text(5)).toContain('1..N VPs per Session');
    expect(await text(6)).toContain('YOUR SYSTEM PROMPTS');
    expect(await text(7)).toContain('Give it a goal');
    expect(await text(9)).toContain('PREVIEW');
    expect(await text(10)).toContain('acceptance checks');
    for (const feature of ['CROSS-DEVICE', 'MULTI-VP', 'SYSTEM PROMPTS', 'WORK CENTER']) expect(await text(11)).toContain(feature);
    expect(Object.keys(deck.files).filter(name => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))).toHaveLength(12);
    const manifest = JSON.parse(await read('assets/capture-manifest.json'));
    expect(manifest.screenshots.find(item => item.file === '04-session-mobile.png').viewport).toEqual({ width: 390, height: 844 });
    const mobile = await read('assets/04-session-mobile.png');
    expect([mobile.readUInt32BE(16), mobile.readUInt32BE(20)]).toEqual([390, 844]);
    for (const n of [4, 5, 8, 9]) {
      expect(await text(n)).toContain('Real Yeaft UI');
      expect(await text(n)).toContain('Staged inspection demo');
    }
    const reviewNotes = await deck.file('ppt/notesSlides/notesSlide5.xml').async('string');
    expect(reviewNotes).toContain('不构成对本 PPT 的真实独立审查');
    expect(await text(8)).toContain('node --check');
    expect(await text(8)).toContain('not a full test suite');
    expect(await text(10)).toContain('not a sandbox');
    const links = await deck.file('ppt/slides/_rels/slide12.xml.rels').async('string');
    expect(links).toContain('https://github.com/yeaft/yeaft-web-code-agent#readme');
  });
});
