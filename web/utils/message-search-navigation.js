function addPersistedMessageId(ids, value) {
  if (typeof value !== 'string' || !/^m\d+$/.test(value) || ids.includes(value)) return;
  ids.push(value);
}

export function persistedMessageIdsForRenderedItem(item) {
  if (!item) return [];
  const ids = [];
  for (const message of Array.isArray(item.messages) ? item.messages : []) {
    addPersistedMessageId(ids, message?.id);
    addPersistedMessageId(ids, message?.messageId);
    addPersistedMessageId(ids, message?.persistedMessageId);
  }
  addPersistedMessageId(ids, item.message?.id);
  addPersistedMessageId(ids, item.messageId);
  addPersistedMessageId(ids, item.atMessageId);
  if (item.type !== 'assistant-turn') addPersistedMessageId(ids, item.id);
  return ids;
}

export async function revealOutlineResult({ result, loadWindow, nextTick, revealMessage, isMobile, closeOutline }) {
  if (!result) return false;
  const loaded = await loadWindow?.(result);
  if (!loaded) return false;
  await nextTick?.();
  const revealed = await revealMessage?.(result.messageId);
  if (revealed && isMobile) closeOutline?.();
  return !!revealed;
}

export function resolvePersistedMessageTarget(blocks, messageId) {
  if (!messageId) return null;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block) continue;
    const items = Array.isArray(block.items) ? block.items : [block];
    for (const item of items) {
      if (!persistedMessageIdsForRenderedItem(item).includes(messageId)) continue;
      const rowId = item?.id;
      const blockId = block?.id;
      if (!rowId || !blockId) return null;
      return {
        blockId,
        rowId,
        collapseKey: block.responseCollapseKey || null,
        requiresExpansion: !!(block.responseCollapsed && item.type === 'assistant-turn'),
      };
    }
  }
  return null;
}

export async function navigateToPersistedMessage({
  blocks,
  messageId,
  collapseStates,
  scrollToBlock,
  findRow,
  flashRow,
  nextTick,
}) {
  const target = resolvePersistedMessageTarget(blocks, messageId);
  if (!target || typeof scrollToBlock !== 'function' || typeof findRow !== 'function') return false;

  if (target.requiresExpansion) {
    if (!target.collapseKey || !collapseStates) return false;
    collapseStates[target.collapseKey] = false;
    await nextTick?.();
  }

  const moved = await scrollToBlock(target.blockId);
  if (!moved) return false;
  await nextTick?.();

  const row = findRow(target.rowId);
  if (!row) return false;
  row.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  flashRow?.(target.rowId);
  return true;
}
