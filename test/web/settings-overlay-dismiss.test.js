import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearOverlayPointerGesture,
  shouldDismissFromOverlayClick,
  trackOverlayPointerDown,
  trackOverlayPointerUp,
} from '../../web/utils/overlay-dismiss.js';

let SettingsPanel;
let SessionSettingsModal;
let WorkCenterSettingsModal;
let ProviderPresetPicker;
let WorkCenterPage;
let YeaftPage;

beforeAll(async () => {
  globalThis.Pinia = {
    defineStore: () => () => ({}),
    useChatStore: () => ({}),
    useAuthStore: () => ({}),
    useSessionsStore: () => ({}),
    useVpStore: () => ({}),
  };
  [
    { default: SettingsPanel },
    { default: SessionSettingsModal },
    { default: WorkCenterSettingsModal },
    { default: ProviderPresetPicker },
    { default: WorkCenterPage },
    { default: YeaftPage },
  ] = await Promise.all([
    import('../../web/components/SettingsPanel.js'),
    import('../../web/components/SessionSettingsModal.js'),
    import('../../web/components/WorkCenterSettingsModal.js'),
    import('../../web/components/ProviderPresetPicker.js'),
    import('../../web/components/WorkCenterPage.js'),
    import('../../web/components/YeaftPage.js'),
  ]);
});

function pointerEvent(overlay, target = overlay) {
  return { currentTarget: overlay, target };
}

function completeBackdropClick(overlay) {
  const event = pointerEvent(overlay);
  trackOverlayPointerDown(event);
  trackOverlayPointerUp(event);
  return event;
}

describe('settings overlay dismissal', () => {
  it('does not dismiss when text selection starts inside the dialog and ends on the backdrop', () => {
    const overlay = {};
    const input = {};

    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));

    expect(shouldDismissFromOverlayClick(pointerEvent(overlay))).toBe(false);
  });

  it('does not dismiss when a gesture starts on the backdrop and ends inside the dialog', () => {
    const overlay = {};
    const input = {};

    trackOverlayPointerDown(pointerEvent(overlay));
    trackOverlayPointerUp(pointerEvent(overlay, input));

    expect(shouldDismissFromOverlayClick(pointerEvent(overlay))).toBe(false);
  });

  it('dismisses only once after a complete backdrop click', () => {
    const overlay = {};
    const event = completeBackdropClick(overlay);

    expect(shouldDismissFromOverlayClick(event)).toBe(true);
    expect(shouldDismissFromOverlayClick(event)).toBe(false);
  });

  it('does not dismiss a cancelled backdrop gesture', () => {
    const overlay = {};
    const event = pointerEvent(overlay);

    trackOverlayPointerDown(event);
    clearOverlayPointerGesture(event);

    expect(shouldDismissFromOverlayClick(event)).toBe(false);
  });

  it('guards global Settings and its QR binding overlay', () => {
    const overlay = {};
    const input = {};
    const vm = { $emit: vi.fn(), cancelQrBind: vi.fn() };

    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    SettingsPanel.methods.onSettingsOverlayClick.call(vm, pointerEvent(overlay));
    expect(vm.$emit).not.toHaveBeenCalled();

    SettingsPanel.methods.onSettingsOverlayClick.call(vm, completeBackdropClick(overlay));
    expect(vm.$emit).toHaveBeenCalledWith('close');

    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    SettingsPanel.methods.onQrOverlayClick.call(vm, pointerEvent(overlay));
    expect(vm.cancelQrBind).not.toHaveBeenCalled();

    SettingsPanel.methods.onQrOverlayClick.call(vm, completeBackdropClick(overlay));
    expect(vm.cancelQrBind).toHaveBeenCalledOnce();
  });

  it('guards Session and Work Center settings while preserving explicit backdrop clicks', () => {
    const overlay = {};
    const input = {};
    const sessionVm = {
      announcementBusy: false,
      renameBusy: false,
      membersBusy: false,
      deleteBusy: false,
      requestClose: vi.fn(),
    };

    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    SessionSettingsModal.methods.onOverlayClick.call(sessionVm, pointerEvent(overlay));
    expect(sessionVm.requestClose).not.toHaveBeenCalled();

    SessionSettingsModal.methods.onOverlayClick.call(sessionVm, completeBackdropClick(overlay));
    expect(sessionVm.requestClose).toHaveBeenCalledOnce();

    const workCenterVm = { close: vi.fn() };
    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    WorkCenterSettingsModal.methods.onOverlayClick.call(workCenterVm, pointerEvent(overlay));
    expect(workCenterVm.close).not.toHaveBeenCalled();

    WorkCenterSettingsModal.methods.onOverlayClick.call(workCenterVm, completeBackdropClick(overlay));
    expect(workCenterVm.close).toHaveBeenCalledOnce();
  });

  it('guards nested provider and Work Center LLM settings', () => {
    const overlay = {};
    const input = {};
    const providerVm = { $emit: vi.fn() };

    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    ProviderPresetPicker.methods.onOverlayClick.call(providerVm, pointerEvent(overlay));
    expect(providerVm.$emit).not.toHaveBeenCalled();

    ProviderPresetPicker.methods.onOverlayClick.call(providerVm, completeBackdropClick(overlay));
    expect(providerVm.$emit).toHaveBeenCalledWith('close');

    const workCenterPageVm = { llmConfigOpen: true };
    trackOverlayPointerDown(pointerEvent(overlay, input));
    trackOverlayPointerUp(pointerEvent(overlay));
    WorkCenterPage.methods.closeLlmConfigFromOverlay.call(workCenterPageVm, pointerEvent(overlay));
    expect(workCenterPageVm.llmConfigOpen).toBe(true);

    WorkCenterPage.methods.closeLlmConfigFromOverlay.call(workCenterPageVm, completeBackdropClick(overlay));
    expect(workCenterPageVm.llmConfigOpen).toBe(false);
  });

  it('wires every settings backdrop to pointer-origin tracking', () => {
    const templates = [
      SettingsPanel.template,
      SessionSettingsModal.template,
      WorkCenterSettingsModal.template,
      ProviderPresetPicker.template,
      WorkCenterPage.template,
      YeaftPage.template,
    ].join('\n');

    expect(SettingsPanel.template).not.toContain('class="settings-overlay" v-if="visible" @click.self');
    expect(SessionSettingsModal.template).not.toContain('class="group-settings-overlay"\n      @click.self');
    expect(WorkCenterSettingsModal.template).not.toContain('work-center-settings-overlay" @click.self');
    expect(ProviderPresetPicker.template).not.toContain('llm-preset-modal-backdrop" @click.self');
    expect(WorkCenterPage.template).not.toContain('yeaft-llm-config-overlay" @click.self');
    expect(YeaftPage.template).not.toContain('yeaft-llm-config-overlay" @click.self');
    expect(templates).toContain('@pointerdown="trackOverlayPointerDown"');
    expect(templates).toContain('@pointerup="trackOverlayPointerUp"');
    expect(templates).toContain('@pointercancel="clearOverlayPointerGesture"');
  });
});
