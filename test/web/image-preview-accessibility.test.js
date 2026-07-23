// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openImagePreview } from '../../web/utils/imagePreview.js';

describe('image preview accessibility', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('opens an accessible dialog and restores focus after Escape', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    openImagePreview('/preview-token', {
      alt: 'Architecture diagram',
      closeLabel: 'Close image preview',
      trigger,
    });

    const overlay = document.querySelector('.image-preview-overlay');
    const image = overlay.querySelector('img');
    const closeButton = overlay.querySelector('.image-preview-close');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.getAttribute('aria-label')).toBe('Architecture diagram');
    expect(image.alt).toBe('Architecture diagram');
    expect(closeButton.getAttribute('aria-label')).toBe('Close image preview');
    expect(document.activeElement).toBe(closeButton);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(trigger);
    overlay.dispatchEvent(new Event('transitionend'));
    expect(document.querySelector('.image-preview-overlay')).toBeNull();
  });

  it('keeps keyboard focus inside the dialog and closes without a transition event', () => {
    vi.useFakeTimers();
    openImagePreview('/preview-token');
    const overlay = document.querySelector('.image-preview-overlay');
    const closeButton = overlay.querySelector('.image-preview-close');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });

    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton);

    closeButton.click();
    vi.advanceTimersByTime(250);
    expect(document.querySelector('.image-preview-overlay')).toBeNull();
  });
});
