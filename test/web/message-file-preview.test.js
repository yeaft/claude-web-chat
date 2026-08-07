// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { decorateMessageFileReferences, resolveMessageFileReference } from '../../web/utils/message-file-reference.js';

const readWeb = path => readFileSync(resolve(process.cwd(), 'web', path), 'utf8');

describe('message file preview', () => {
  it('accepts local code and document references while leaving web links alone', () => {
    expect(resolveMessageFileReference('docs/design-doc.md#L119')).toEqual({ path: 'docs/design-doc.md', line: 119 });
    expect(resolveMessageFileReference('./src/main.js:42')).toEqual({ path: './src/main.js', line: 42 });
    expect(resolveMessageFileReference('/workspace/readme.md')).toEqual({ path: '/workspace/readme.md', line: null });
    expect(resolveMessageFileReference('file:///workspace/spec.pdf')).toEqual({ path: '/workspace/spec.pdf', line: null });
    expect(resolveMessageFileReference('https://example.test/design-doc.md')).toBeNull();
    expect(resolveMessageFileReference('#section')).toBeNull();
    expect(resolveMessageFileReference('/api/files/readme.md')).toBeNull();
  });

  it('rejects Git refs and versions without blocking recognizable extensionless files', () => {
    expect(resolveMessageFileReference('origin/main')).toBeNull();
    expect(resolveMessageFileReference('feature/message-preview')).toBeNull();
    expect(resolveMessageFileReference('v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('release/v1.0.403')).toBeNull();
    expect(resolveMessageFileReference('./v1.0.403')).toEqual({ path: './v1.0.403', line: null });
    expect(resolveMessageFileReference('/workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('file:///workspace/v1.0.403')).toEqual({ path: '/workspace/v1.0.403', line: null });
    expect(resolveMessageFileReference('artifact.7z')).toEqual({ path: 'artifact.7z', line: null });
    expect(resolveMessageFileReference('README')).toEqual({ path: 'README', line: null });
    expect(resolveMessageFileReference('Dockerfile')).toEqual({ path: 'Dockerfile', line: null });
    expect(resolveMessageFileReference('docs/README')).toEqual({ path: 'docs/README', line: null });
    expect(resolveMessageFileReference('.gitignore')).toEqual({ path: '.gitignore', line: null });
  });

  it('decorates file links and standalone inline-code references without touching code blocks', () => {
    const html = decorateMessageFileReferences([
      '<a href="docs/design-doc.md#L119">design doc</a>',
      '<a class="existing" href="docs/notes.md">notes</a>',
      '<a href="https://example.test">web</a>',
      '<code>web/components/WorkbenchPanel.js:1</code>',
      '<code>origin/main</code>',
      '<code>v1.0.403</code>',
      '<pre><code>web/components/FilesTab.js:17</code></pre>',
    ].join(' '));

    expect(html).toContain('href="docs/design-doc.md#L119" class="message-file-reference"');
    expect(html).toContain('class="existing message-file-reference" href="docs/notes.md"');
    expect(html).not.toMatch(/<a[^>]*\bclass=[^>]*\bclass=/);
    expect(html).toContain('<a href="web/components/WorkbenchPanel.js:1" class="message-file-reference"');
    expect(html).toContain('<code>origin/main</code>');
    expect(html).toContain('<code>v1.0.403</code>');
    expect(html).not.toContain('href="origin/main"');
    expect(html).not.toContain('href="v1.0.403"');
    expect(html).toContain('<a href="https://example.test">web</a>');
    expect(html).toContain('<pre><code>web/components/FilesTab.js:17</code></pre>');
  });

  it('opens a local Markdown link in the message file panel without intercepting external links', async () => {
    const openFileInExplorer = vi.fn();
    globalThis.Vue = Vue;
    globalThis.Pinia = {
      defineStore: () => () => ({}),
      useChatStore: () => ({
        answerUserQuestion: vi.fn(),
        cancelVpTurn: vi.fn(),
        openFileInExplorer,
      }),
    };
    globalThis.marked = {
      setOptions: vi.fn(),
      parse: vi.fn(() => '<p><a href="docs/design-doc.md#L119">design doc</a> <a href="https://example.test">web</a></p>'),
    };
    globalThis.hljs = undefined;
    const { default: AssistantTurn } = await import('../../web/components/AssistantTurn.js');
    const wrapper = mount(AssistantTurn, {
      props: {
        turn: {
          id: 'turn-file-preview',
          textContent: 'links',
          textSegments: [{ key: 'result', content: 'links', kind: 'result' }],
          toolMsgs: [], imageMsgs: [], todoMsg: null, askMsg: null, isStreaming: false,
        },
      },
      global: {
        mocks: { $t: key => key },
        provide: { t: key => key },
        stubs: { ToolLine: true, AskCard: true, VpSpeakerHeader: true },
      },
    });

    await wrapper.get('a[href="docs/design-doc.md#L119"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledWith('docs/design-doc.md', { hideTree: true, line: 119 });

    await wrapper.get('a[href="https://example.test"]').trigger('click');
    expect(openFileInExplorer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('wires the right panel to the complete Files experience with a collapsed tree by default', () => {
    const filesTab = readWeb('components/FilesTab.js');
    const workbench = readWeb('components/WorkbenchPanel.js');
    const chatPage = readWeb('components/ChatPage.js');
    const chatHeader = readWeb('components/ChatHeader.js');
    const yeaftPage = readWeb('components/YeaftPage.js');
    const yeaftActions = readWeb('components/YeaftSessionActions.js');
    const yeaftSidebar = readWeb('components/YeaftSidebar.js');

    expect(filesTab).toContain('treeInitiallyVisible');
    expect(filesTab).toContain("'tree-collapsed': !treeVisible");
    expect(filesTab.match(/class="vscode-action-btn file-tree-collapse-btn"/g)).toHaveLength(2);
    expect(filesTab.match(/d="M8\.59 16\.59 13\.17 12 8\.59 7\.41 10 6l6 6-6 6z"/g)).toHaveLength(2);
    expect(filesTab).not.toContain('d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"');
    expect(filesTab).toContain('class="file-tree-collapsed-rail"');
    expect(filesTab).not.toContain('class="file-tree-toggle"');
    const filesCss = readWeb('styles/files.css');
    const mobileCss = filesCss.slice(filesCss.indexOf('@media (max-width: 768px)'));
    expect(mobileCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*display:\s*none;/s);
    expect(mobileCss).toMatch(/\.file-two-col\.tree-collapsed \.file-col-tree\s*\{[^}]*display:\s*flex;/s);
    const wsHandler = readWeb('components/files/wsHandler.js');
    expect(wsHandler).toContain('pendingRevealLines.set(nPath, line)');
    expect(wsHandler.match(/msg\.requestedFilePath \|\| msg\.filePath/g)).toHaveLength(2);
    expect(readWeb('../agent/workbench/file-ops.js').match(/requestedFilePath: filePath/g)).toHaveLength(3);
    expect(filesCss).toMatch(/\.file-tree-collapsed-rail\s*\{[^}]*order:\s*4;[^}]*border-left:/s);
    expect(filesCss).toMatch(/\.file-col-tree\s*\{[^}]*order:\s*3;/s);
    expect(filesCss).toMatch(/\.file-col-content\s*\{[^}]*order:\s*1;/s);
    expect(filesCss).toMatch(/\.file-tree-splitter\s*\{[^}]*order:\s*2;/s);
    expect(filesTab).toContain('startWidth - (clientX - startX)');
    expect(workbench).toContain('<FilesTab');
    expect(workbench).toContain(':tree-initially-visible="false"');
    expect(workbench).toContain('class="wb-tab-action workbench-maximize-btn"');
    expect(workbench).toContain(':aria-label="store.workbenchMaximized ? $t(\'workbench.restore\') : $t(\'workbench.maximize\')"');
    expect(workbench).toContain('d="M7 14H5v5h5v-2H7v-3z');
    expect(workbench).toContain('d="M5 16h3v3h2v-5H5v2z');
    expect(readWeb('stores/chat.js')).toContain('else Vue.nextTick(dispatchOpen);');
    expect(chatPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(chatPage.indexOf('<div class="chat-body"'));
    expect(chatHeader).toContain("$t('chat.sidebar.workbench')");
    expect(yeaftActions).toContain("@click=\"$emit('toggle-workbench')\"");
    expect(yeaftPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(yeaftPage.indexOf('<div class="yeaft-main"'));
    const yeaftCss = readWeb('styles/yeaft.css');
    expect(yeaftCss).toMatch(/\.yeaft-main\.workbench-maximized\s*\{[^}]*display:\s*none;/s);
    expect(yeaftCss).not.toContain('.yeaft-main.workbench-maximized > .yeaft-main-center');
    expect(yeaftSidebar).not.toContain('@click="onToggleWorkbench"');
  });
});
