import { compile } from '@vue/compiler-dom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('Session message quote UI wiring', () => {
  it('shows removable quote context in ChatInput and sends structured quote data', async () => {
    const component = await import('../../web/components/ChatInput.js');
    const source = read('components/ChatInput.js');
    compile(component.default.template);

    expect(source).toContain('class="input-quote-preview"');
    expect(source).toContain("emits: ['remove-quote', 'quote-consumed']");
    expect(source).toContain('if (props.quote) props.sendFn(trimmed, attachmentPayload, props.quote)');
    expect(source).toContain('else props.sendFn(trimmed, attachmentPayload)');
    expect(source).toContain("if (props.quote) emit('quote-consumed')");
    expect(source).toContain('const replaceDraft = (text) =>');
  });

  it('wires quote and edit-as-new actions only on the Yeaft Session page', () => {
    const page = read('components/YeaftPage.js');
    const list = read('components/MessageList.js');
    const assistant = read('components/AssistantTurn.js');
    const user = read('components/MessageItem.js');

    expect(page).toContain('@quote-message="setMessageQuote"');
    expect(page).toContain('@edit-message-as-new="editMessageAsNew"');
    expect(page).toContain(':quote="messageQuote"');
    expect(page).toContain('store.sendYeaftSessionMessage({ groupId, text, mentions, attachments, quote })');
    expect(list).toContain("'quote-message', 'edit-message-as-new'");
    expect(assistant).toContain("quoteFromAssistantTurn");
    expect(user).toContain("quoteFromUserMessage");
  });

  it('uses the shared short date-time formatting across Session messages', () => {
    for (const file of ['MessageItem.js', 'AssistantTurn.js', 'VpTurnBlock.js', 'VpSpeakerHeader.js']) {
      expect(read(`components/${file}`)).toContain('formatSessionMessageDateTime');
    }
  });

  it('renders the user timestamp above content and keeps actions below it', () => {
    const user = read('components/MessageItem.js');
    const timestamp = user.indexOf('class="message-user-meta"');
    const content = user.indexOf('class="message-content"');
    const footer = user.indexOf('class="message-user-footer"');

    expect(timestamp).toBeGreaterThan(-1);
    expect(timestamp).toBeLessThan(content);
    expect(content).toBeLessThan(footer);
    expect(user).toContain('aria-hidden="true"');
  });

  it('keeps VP timestamps in the speaker header and adds quote icons to response actions', () => {
    const assistant = read('components/AssistantTurn.js');
    const vpTurn = read('components/VpTurnBlock.js');

    expect(assistant).toContain('v-if="turnTime && !turn.speakerVpId"');
    expect(assistant).toContain('@click="$emit(\'quote\', assistantQuote)"');
    expect(assistant).toContain('<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">');
    expect(vpTurn).toContain('class="vp-turn-block-time"');
  });

  it('uses concise localized new-message labels', () => {
    expect(read('i18n/en.js')).toContain("'message.editAsNew': 'New message'");
    expect(read('i18n/zh-CN.js')).toContain("'message.editAsNew': '新消息'");
  });
});
