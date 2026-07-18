// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Vue from 'vue';

let browser;
let ChatInput;
let SessionCreateModal;

const vpList = [
  {
    vpId: 'linus',
    displayName: 'Linus Torvalds',
    description: 'Systems engineering',
    area: 'engineering',
  },
];

function chatStore() {
  return Vue.reactive({
    activeConversationId: 'conversation-a',
    btwMode: false,
    compactStatus: null,
    currentAgent: 'agent-a',
    currentConversation: 'conversation-a',
    currentView: 'yeaft',
    customExpertRoles: [],
    expertSelections: [],
    inputDrafts: {},
    isProcessing: false,
    locale: 'en',
    slashCommandDescriptions: {},
    yeaftActiveSessionFilter: null,
  });
}

function mountOptions() {
  return {
    global: {
      mocks: {
        $t: key => key,
      },
    },
    attachTo: document.body,
  };
}

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useAuthStore: () => ({ getActiveToken: () => null }),
    useChatStore: chatStore,
    useSessionsStore: () => ({ activeSessionId: null, sessions: {} }),
    useVpStore: () => ({
      vpList,
      vpDescription: vpId => vpList.find(vp => vp.vpId === vpId)?.description || '',
      vpTextColor: () => 'var(--text-primary)',
    }),
  };
  globalThis.window.Pinia = globalThis.Pinia;
  ({ default: ChatInput } = await import('../../web/components/ChatInput.js'));
  ({ default: SessionCreateModal } = await import('../../web/components/SessionCreateModal.js'));
  browser = await chromium.launch({ headless: true });
});

afterEach(() => {
  document.body.innerHTML = '';
});

afterAll(async () => {
  await browser?.close();
});

describe('VP selector rendered DOM accessibility', () => {
  it('keeps the mention host as a native textarea while linking the active listbox option', async () => {
    const wrapper = mount(ChatInput, {
      ...mountOptions(),
      props: { sendFn: () => {} },
    });
    const textarea = wrapper.get('textarea');

    await textarea.setValue('@');
    await textarea.trigger('input');
    await Vue.nextTick();

    const element = textarea.element;
    const listbox = document.getElementById(element.getAttribute('aria-controls'));
    const activeOption = document.getElementById(element.getAttribute('aria-activedescendant'));

    expect(element.tagName).toBe('TEXTAREA');
    expect(element.hasAttribute('role')).toBe(false);
    expect(element.hasAttribute('aria-expanded')).toBe(false);
    expect(element.getAttribute('aria-autocomplete')).toBe('list');
    expect(element.getAttribute('aria-haspopup')).toBe('listbox');
    expect(element.id).toMatch(/^chat-input-\d+$/);
    expect(listbox?.getAttribute('role')).toBe('listbox');
    expect(activeOption?.getAttribute('role')).toBe('option');
    expect(listbox?.contains(activeOption)).toBe(true);

    const renderedHtml = document.body.innerHTML;
    const page = await browser.newPage();
    try {
      await page.setContent(renderedHtml);
      const textareaHandle = await page.$('textarea');
      const session = await page.context().newCDPSession(page);
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'textarea',
      });
      const { node } = await session.send('DOM.describeNode', { nodeId });
      const { nodes } = await session.send('Accessibility.getPartialAXTree', {
        backendNodeId: node.backendNodeId,
        fetchRelatives: false,
      });
      const axNode = nodes[0];
      const properties = Object.fromEntries(
        (axNode.properties || []).map(property => [property.name, property.value?.value]),
      );

      expect(textareaHandle).not.toBeNull();
      expect(axNode.role?.value).toBe('textbox');
      expect(properties.multiline).toBe(true);
      expect(properties.autocomplete).toBe('list');
      expect(properties.hasPopup).toBe('listbox');
    } finally {
      await page.close();
    }

    wrapper.unmount();
  });

  it('renders the create trigger as a disclosure for the native checklist, not a menu popup', async () => {
    const wrapper = mount(SessionCreateModal, mountOptions());
    const triggerElement = document.body.querySelector('.yeaft-roster-trigger');
    expect(triggerElement).not.toBeNull();

    expect(triggerElement.getAttribute('aria-expanded')).toBe('false');
    expect(triggerElement.getAttribute('aria-controls')).toBe('yeaft-session-create-vp-picker');
    expect(triggerElement.hasAttribute('aria-haspopup')).toBe(false);

    triggerElement.click();
    await Vue.nextTick();

    const checklist = document.getElementById(triggerElement.getAttribute('aria-controls'));
    expect(triggerElement.getAttribute('aria-expanded')).toBe('true');
    expect(checklist?.getAttribute('role')).toBe('group');
    expect(checklist?.querySelector('input[type="checkbox"]')).not.toBeNull();

    const renderedHtml = document.body.innerHTML;
    const page = await browser.newPage();
    try {
      await page.setContent(renderedHtml);
      const session = await page.context().newCDPSession(page);
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: '.yeaft-roster-trigger',
      });
      const { node } = await session.send('DOM.describeNode', { nodeId });
      const { nodes } = await session.send('Accessibility.getPartialAXTree', {
        backendNodeId: node.backendNodeId,
        fetchRelatives: false,
      });
      const properties = Object.fromEntries(
        (nodes[0].properties || []).map(property => [property.name, property.value?.value]),
      );

      expect(nodes[0].role?.value).toBe('button');
      expect(properties.expanded).toBe(true);
      expect(properties.hasPopup).toBeUndefined();
    } finally {
      await page.close();
    }

    wrapper.unmount();
  });
});
