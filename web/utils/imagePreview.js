function normalizeGalleryEntry(entry, fallbackAlt) {
  if (typeof entry === 'string') {
    return entry ? { src: entry, alt: fallbackAlt } : null;
  }
  if (!entry || typeof entry !== 'object' || !entry.src) return null;
  return {
    src: entry.src,
    alt: entry.alt || fallbackAlt,
  };
}

/**
 * Opens a full-screen image preview overlay.
 * Click the backdrop or press Escape to close. Multi-image galleries support
 * previous/next controls and the Left/Right arrow keys.
 */
export function openImagePreview(src, {
  alt = 'Preview',
  closeLabel = 'Close',
  previousLabel = 'Previous image',
  nextLabel = 'Next image',
  positionLabel = (current, total) => `${current} / ${total}`,
  gallery = null,
  initialIndex = null,
  trigger = null,
} = {}) {
  if (!src) return null;

  const entries = (Array.isArray(gallery) ? gallery : [src])
    .map(entry => normalizeGalleryEntry(entry, alt))
    .filter(Boolean);
  if (entries.length === 0) entries.push({ src, alt });

  let currentIndex = Number.isInteger(initialIndex)
    && initialIndex >= 0
    && initialIndex < entries.length
    ? initialIndex
    : entries.findIndex(entry => entry.src === src);
  if (currentIndex < 0) currentIndex = 0;

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.draggable = false;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-preview-close';
  closeButton.setAttribute('aria-label', closeLabel);
  closeButton.setAttribute('title', closeLabel);
  closeButton.textContent = '×';

  let previousButton = null;
  let nextButton = null;
  let position = null;
  if (entries.length > 1) {
    previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'image-preview-navigation image-preview-previous';
    previousButton.setAttribute('aria-label', previousLabel);
    previousButton.setAttribute('title', previousLabel);
    previousButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m15 18-6-6 6-6"/></svg>';

    nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'image-preview-navigation image-preview-next';
    nextButton.setAttribute('aria-label', nextLabel);
    nextButton.setAttribute('title', nextLabel);
    nextButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6"/></svg>';

    position = document.createElement('div');
    position.className = 'image-preview-position';
    position.setAttribute('aria-live', 'polite');
  }

  const render = () => {
    const entry = entries[currentIndex];
    img.src = entry.src;
    img.alt = entry.alt;
    overlay.setAttribute('aria-label', entry.alt);
    if (position) {
      position.textContent = typeof positionLabel === 'function'
        ? positionLabel(currentIndex + 1, entries.length)
        : `${currentIndex + 1} / ${entries.length}`;
    }
  };
  const move = (delta) => {
    currentIndex = (currentIndex + delta + entries.length) % entries.length;
    render();
  };

  render();
  overlay.append(img);
  if (previousButton && nextButton && position) {
    overlay.append(previousButton, nextButton, position);
  }
  overlay.append(closeButton);
  document.body.appendChild(overlay);

  // Force reflow then add visible class for transition.
  overlay.offsetHeight; // eslint-disable-line no-unused-expressions
  overlay.classList.add('visible');
  closeButton.focus();

  let closing = false;
  let fallbackTimer = null;
  const remove = () => {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = null;
    if (overlay.isConnected) overlay.remove();
  };
  const close = () => {
    if (closing) return;
    closing = true;
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', remove, { once: true });
    fallbackTimer = setTimeout(remove, 250);
    document.removeEventListener('keydown', onKey);
    if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
  };

  const focusableControls = [previousButton, nextButton, closeButton].filter(Boolean);
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (entries.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const activeIndex = focusableControls.indexOf(document.activeElement);
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = activeIndex < 0
        ? 0
        : (activeIndex + direction + focusableControls.length) % focusableControls.length;
      focusableControls[nextIndex].focus();
    }
  };

  closeButton.addEventListener('click', close);
  previousButton?.addEventListener('click', () => move(-1));
  nextButton?.addEventListener('click', () => move(1));
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  document.addEventListener('keydown', onKey);
  return overlay;
}
