const pointerGestures = new WeakMap();

/**
 * Record where a pointer gesture starts. A click target alone is insufficient:
 * browsers can target the overlay when text selection starts inside a dialog
 * and the pointer is released outside it.
 */
export function trackOverlayPointerDown(event) {
  const overlay = event?.currentTarget;
  if (!overlay) return;
  pointerGestures.set(overlay, {
    startedOnOverlay: event.target === overlay,
    endedOnOverlay: false,
  });
}

export function trackOverlayPointerUp(event) {
  const overlay = event?.currentTarget;
  const gesture = overlay && pointerGestures.get(overlay);
  if (gesture) gesture.endedOnOverlay = event.target === overlay;
}

export function clearOverlayPointerGesture(event) {
  const overlay = event?.currentTarget;
  if (overlay) pointerGestures.delete(overlay);
}

/**
 * Return true only when both ends of the pointer gesture hit the backdrop.
 */
export function shouldDismissFromOverlayClick(event) {
  const overlay = event?.currentTarget;
  if (!overlay) return false;
  const gesture = pointerGestures.get(overlay);
  const shouldDismiss = event.target === overlay
    && gesture?.startedOnOverlay === true
    && gesture.endedOnOverlay === true;
  pointerGestures.delete(overlay);
  return shouldDismiss;
}
