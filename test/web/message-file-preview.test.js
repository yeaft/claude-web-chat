// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { resolveMessageFileReference } from '../../web/utils/message-file-reference.js';

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
    expect(filesTab).toContain('@click="treeVisible = !treeVisible"');
    expect(readWeb('components/files/wsHandler.js')).toContain('pendingRevealLines.set(nPath, line)');
    expect(workbench).toContain('<FilesTab');
    expect(workbench).toContain(':tree-initially-visible="false"');
    expect(readWeb('stores/chat.js')).toContain('else Vue.nextTick(dispatchOpen);');
    expect(chatPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(chatPage.indexOf('<div class="chat-body"'));
    expect(chatHeader).toContain("$t('chat.sidebar.workbench')");
    expect(yeaftActions).toContain("@click=\"$emit('toggle-workbench')\"");
    expect(yeaftPage.indexOf('<WorkbenchPanel')).toBeGreaterThan(yeaftPage.indexOf('<div class="yeaft-main"'));
    expect(yeaftSidebar).not.toContain('@click="onToggleWorkbench"');
  });
});
