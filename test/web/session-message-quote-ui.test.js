import { compile } from '@vue/compiler-dom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('Session message quote UI wiring', () => {


  it('keeps the attachment badge last in the user action footer', () => {
    const user = read('components/MessageItem.js');
    const footerStart = user.indexOf('class="message-user-footer"');
    const footerEnd = user.indexOf('<!-- Expanded attachments preview -->');
    const footer = user.slice(footerStart, footerEnd);

    expect(footer).toContain('class="attachments-badge"');
    expect(footer.indexOf("$emit('edit-as-new'")).toBeLessThan(footer.indexOf('class="attachments-badge"'));
    expect(user).not.toContain('class="user-attachments-indicator"');
  });


  it('uses concise localized edit labels', () => {
    expect(read('i18n/en.js')).toContain("'message.editAsNew': 'Edit'");
    expect(read('i18n/zh-CN.js')).toContain("'message.editAsNew': '编辑'");
  });
});
