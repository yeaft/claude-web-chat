/**
 * Opens a full-screen image preview overlay.
 * Click on the backdrop or press Escape to close.
 */
export function openImagePreview(src) {
  if (!src) return;

  const overlay = document.createElement('div');
  overlay.className = 'image-preview-overlay';

  const img = document.createElement('img');
  img.className = 'image-preview-img';
  img.src = src;
  img.alt = 'Preview';

  overlay.appendChild(img);
  document.body.appendChild(overlay);

  // Force reflow then add visible class for transition
  overlay.offsetHeight; // eslint-disable-line no-unused-expressions
  overlay.classList.add('visible');

  const close = () => {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  // Close on backdrop click (not on img click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.addEventListener('keydown', onKey);
}
