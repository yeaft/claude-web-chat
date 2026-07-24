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
    expect(source).toContain('props.sendFn(trimmed, attachmentInfos.length > 0 ? attachmentInfos : undefined, props.quote || undefined)');
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

  it('uses complete date-time formatting across user and assistant Session messages', () => {
    for (const file of ['MessageItem.js', 'AssistantTurn.js', 'VpTurnBlock.js', 'VpSpeakerHeader.js']) {
      expect(read(`components/${file}`)).toContain('formatSessionMessageDateTime');
    }
  });
});
