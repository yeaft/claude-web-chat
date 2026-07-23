/**
 * Opens a full-screen image preview overlay.
 * Click on the backdrop or press Escape to close.
 */
export function openImagePreview(src, { alt = 'Preview', closeLabel = 'Close', trigger = null } = {}) {
  if (!src) return;

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', alt);

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.src = src;
  img.alt = alt;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'image-preview-close';
  closeButton.setAttribute('aria-label', closeLabel);
  closeButton.textContent = '×';

  overlay.append(img, closeButton);
  document.body.appendChild(overlay);

  // Force reflow then add visible class for transition
  overlay.offsetHeight; // eslint-disable-line no-unused-expressions
  overlay.classList.add('visible');
  closeButton.focus();

  let closing = false;
  const remove = () => overlay.remove();
  const close = () => {
    if (closing) return;
    closing = true;
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 250);
    document.removeEventListener('keydown', onKey);
    if (trigger?.isConnected && typeof trigger.focus === 'function') trigger.focus();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      event.preventDefault();
      closeButton.focus();
    }
  };

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  document.addEventListener('keydown', onKey);
}
