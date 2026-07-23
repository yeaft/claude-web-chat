// @vitest-environment happy-dom
import * as Vue from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let AssistantTurn;
let MessageItem;

const translations = {
  en: {
    'common.close': 'Close',
    'message.imagePreview': 'Image preview',
    'message.imageCount': ({ count }) => `${count} image`,
    'message.fileCount': ({ count }) => `${count} file`,
    'common.comma': ', ',
  },
  zh: {
    'common.close': '关闭',
    'message.imagePreview': '图片预览',
    'message.imageCount': ({ count }) => `${count} 张图片`,
    'message.fileCount': ({ count }) => `${count} 个文件`,
    'common.comma': '，',
  },
};

function translator(language) {
  return (key, values = {}) => {
    const value = translations[language][key];
    return typeof value === 'function' ? value(values) : value || key;
  };
}

function globalOptions(language) {
  const t = translator(language);
  return {
    provide: { t },
    mocks: { $t: t },
    stubs: {
      ToolLine: true,
      AskCard: true,
      VpSpeakerHeader: true,
    },
  };
}

function closeWithEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  document.querySelector('.image-preview-overlay')?.dispatchEvent(new Event('transitionend'));
}

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => ({ customExpertRoles: [] }),
    useVpStore: () => ({ vpTextColor: () => 'var(--text-primary)' }),
  };
  globalThis.window.Pinia = globalThis.Pinia;
  ({ default: AssistantTurn } = await import('../../web/components/AssistantTurn.js'));
  ({ default: MessageItem } = await import('../../web/components/MessageItem.js'));
});

describe('ordinary Chat image preview focus', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('restores focus to an AssistantTurn image button after Escape', async () => {
    const wrapper = mount(AssistantTurn, {
      attachTo: document.body,
      props: {
        turn: {
          id: 'turn-1',
          imageMsgs: [{ id: 'image-1', src: '/assistant-image', filename: 'result.png' }],
          toolMsgs: [],
        },
      },
      global: globalOptions('en'),
    });
    const trigger = wrapper.get('.turn-image-item');

    await trigger.trigger('click');
    const dialog = document.querySelector('.image-preview-overlay');
    const closeButton = dialog.querySelector('.image-preview-close');
    expect(dialog.getAttribute('aria-label')).toBe('result.png');
    expect(closeButton.getAttribute('aria-label')).toBe('Close');
    expect(document.activeElement).toBe(closeButton);

    closeWithEscape();
    expect(document.activeElement).toBe(trigger.element);
  });

  it('uses a semantic user image button and localized Chinese dialog labels', async () => {
    const wrapper = mount(MessageItem, {
      attachTo: document.body,
      props: {
        message: {
          type: 'user',
          content: '附件',
          attachments: [{ isImage: true, preview: '/user-image', name: '' }],
        },
      },
      global: globalOptions('zh'),
    });

    await wrapper.get('.attachments-badge').trigger('click');
    const trigger = wrapper.get('button.user-attachment-item.is-image');
    expect(trigger.attributes('type')).toBe('button');
    await trigger.trigger('click');

    const dialog = document.querySelector('.image-preview-overlay');
    const closeButton = dialog.querySelector('.image-preview-close');
    expect(dialog.getAttribute('aria-label')).toBe('图片预览');
    expect(dialog.querySelector('img').alt).toBe('图片预览');
    expect(closeButton.getAttribute('aria-label')).toBe('关闭');
    expect(document.activeElement).toBe(closeButton);

    closeWithEscape();
    expect(document.activeElement).toBe(trigger.element);
  });
});
