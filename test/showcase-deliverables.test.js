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
    for (const name of ['README.md', 'assets/capture-manifest.json', 'assets/01-home.png', 'assets/04-session-conversation.png', 'assets/05-session-roster.png', 'assets/08-workbench-files-correct.png', 'assets/08-workbench-terminal-correct.png', 'assets/09-work-center-structure.png']) {
      expect(await archive.file(name).async('nodebuffer')).toEqual(await read(name));
    }
  });

  it('distinguishes product topology from delivery evidence and labels staged screenshots', async () => {
    const deck = await JSZip.loadAsync(await read('yeaft-editorial-minimal.pptx'));
    const names = Object.keys(deck.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(names).toHaveLength(12);
    const text = async n => slideText(await deck.file(`ppt/slides/slide${n}.xml`).async('string'));
    expect(await text(3)).toContain('Product map'.toUpperCase());
    expect(await text(3)).toContain('Authentication + relay');
    expect(await text(11)).toContain('inspected, not modified');
    expect(await text(11)).toContain('not a real PR approval');
    for (const n of [4, 5, 8, 9]) expect(await text(n)).toContain('Real Yeaft UI');
    expect(await text(8)).toContain('node --check');
    expect(await text(10)).toContain('not a sandbox');
    const links = await deck.file('ppt/slides/_rels/slide12.xml.rels').async('string');
    expect(links).toContain('https://github.com/yeaft/yeaft-web-code-agent#readme');
  });
});
