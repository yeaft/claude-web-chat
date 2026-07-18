import { describe, expect, it } from 'vitest';

globalThis.Pinia = globalThis.Pinia || {};
if (typeof globalThis.Pinia.defineStore !== 'function') {
  globalThis.Pinia.defineStore = () => () => ({});
}

const { default: SessionCreateModal, resolveVpRosterPopupLayout } = await import(
  '../../web/components/SessionCreateModal.js'
);
const { default: SessionSettingsModal } = await import('../../web/components/SessionSettingsModal.js');
const { default: ChatInput } = await import('../../web/components/ChatInput.js');
const {
  default: VpMentionAutocomplete,
  vpMentionListboxId,
  vpMentionOptionId,
} = await import('../../web/components/VpMentionAutocomplete.js');

function openTag(template, selector) {
  const start = template.indexOf(selector);
  if (start < 0) throw new Error(`Missing template selector: ${selector}`);
  const tagStart = template.lastIndexOf('<', start);
  const tagEnd = template.indexOf('>', start);
  return template.slice(tagStart, tagEnd + 1);
}

describe('VP selector accessibility and popup layout', () => {
  it('places the roster in the side that fits inside the modal and viewport', () => {
    const modal = { top: 40, bottom: 350 };
    const viewport = { top: 0, bottom: 390 };

    expect(resolveVpRosterPopupLayout(
      { top: 260, bottom: 300 },
      modal,
      viewport,
      220,
    )).toEqual({ placement: 'up', availableHeight: 216 });

    expect(resolveVpRosterPopupLayout(
      { top: 90, bottom: 130 },
      modal,
      viewport,
      180,
    )).toEqual({ placement: 'down', availableHeight: 216 });
  });

  it('limits the roster to the larger side when neither side fits in low-height layouts', () => {
    const layout = resolveVpRosterPopupLayout(
      { top: 210, bottom: 250 },
      { top: 60, bottom: 330 },
      { top: 0, bottom: 390 },
      360,
    );

    expect(layout).toEqual({ placement: 'up', availableHeight: 146 });
    expect(layout.availableHeight).toBeLessThanOrEqual(210 - 60);
  });

  it('keeps native checkbox and button semantics in create and settings lists', () => {
    for (const template of [SessionCreateModal.template, SessionSettingsModal.template]) {
      expect(template).not.toContain('role="option"');
      expect(template).not.toContain('aria-multiselectable');
      expect(template).toContain('type="checkbox"');
      expect(template).toContain('aria-pressed');
    }

    const createTrigger = openTag(SessionCreateModal.template, 'class="yeaft-roster-trigger"');
    expect(createTrigger).toContain(':aria-expanded="vpRosterOpen"');
    expect(createTrigger).toContain('aria-controls="yeaft-session-create-vp-picker"');
    expect(createTrigger).not.toContain('aria-haspopup');
    expect(openTag(SessionCreateModal.template, 'class="yeaft-roster-list yeaft-roster-popup"'))
      .toContain('role="group"');
    expect(openTag(SessionSettingsModal.template, 'class="group-settings-roster"'))
      .toContain('role="group"');
  });

  it('associates the focused textarea with the grouped mention list and active option', () => {
    const inputId = 'chat-input-17';
    expect(vpMentionListboxId(inputId)).toBe('chat-input-17-vp-mention-listbox');
    expect(vpMentionOptionId(inputId, 'custom vp')).toBe('chat-input-17-vp-mention-option-custom-vp');

    const textarea = openTag(ChatInput.template, '<textarea');
    expect(textarea).not.toContain('role=');
    expect(textarea).not.toContain('aria-expanded');
    expect(textarea).toContain('aria-autocomplete="list"');
    expect(textarea).toContain('aria-haspopup="listbox"');
    expect(textarea).toContain(':aria-controls="vpMentionPopupOpen ? vpMentionPopupId : null"');
    expect(textarea).toContain(':aria-activedescendant="vpMentionActiveOptionId"');

    expect(VpMentionAutocomplete.template).toContain('role="listbox"');
    expect(VpMentionAutocomplete.template).toContain('role="group"');
    expect(VpMentionAutocomplete.template).toContain(':aria-labelledby="domainLabelId(domain.key)"');
    expect(VpMentionAutocomplete.template).toContain(':id="optionId(item.vp.vpId)"');
    expect(VpMentionAutocomplete.template).not.toContain('role="separator"');
  });
});
