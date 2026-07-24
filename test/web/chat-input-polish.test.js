import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const component = readFileSync(resolve(repoRoot, 'web/components/ChatInput.js'), 'utf8');
const styles = readFileSync(resolve(repoRoot, 'web/styles/chat-input.css'), 'utf8');
const english = readFileSync(resolve(repoRoot, 'web/i18n/en.js'), 'utf8');
const chinese = readFileSync(resolve(repoRoot, 'web/i18n/zh-CN.js'), 'utf8');

describe('ChatInput interaction polish', () => {
  it('uses one primary execution control at a time', () => {
    expect(component).toContain('v-if="isStopVisible"');
    expect(component).toContain('v-else\n          type="button"\n          class="send-btn"');
    expect(component).toContain(":aria-label=\"$t('chatInput.stop')\"");
    expect(component).toContain(":aria-label=\"$t('chatInput.send')\"");
    expect(component).toContain('if (isStopVisible.value || !canSend.value) return;');
  });

  it('only enables internal scrolling after the textarea reaches its height cap', () => {
    expect(component).toContain('const MAX_TEXTAREA_HEIGHT = 120;');
    expect(component).toContain("textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';");
    expect(component).toContain("textarea.style.overflowY = 'hidden';");
    expect(component).toContain('resetTextareaSize();');
    expect(styles).toContain('max-height: 120px;\n  overflow-y: hidden;');
  });

  it('uses theme tokens for the stop control', () => {
    expect(styles).toContain('.send-btn.stop-btn {\n  background: var(--error);');
    expect(styles).not.toMatch(/\.send-btn\.stop-btn[\s\S]*?#[0-9a-f]{3,8}/i);
  });

  it('keeps attachment status strings localized in both languages', () => {
    for (const key of ['chatInput.uploading', 'chatInput.uploadFailed', 'chatInput.retryUpload', 'chatInput.removeAttachment']) {
      expect(english).toContain(`'${key}'`);
      expect(chinese).toContain(`'${key}'`);
    }
  });
});
