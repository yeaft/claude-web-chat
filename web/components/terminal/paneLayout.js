/**
 * Pure utility functions for terminal pane tree layout.
 */

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export function generateTerminalId(convId) {
  return convId + ':' + Math.random().toString(36).slice(2, 8);
}

export function collectLeaves(node) {
  if (!node) return [];
  if (node.type === 'pane') return [node.terminalId];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function findFirstLeaf(node) {
  if (!node) return null;
  if (node.type === 'pane') return node.terminalId;
  return findFirstLeaf(node.first);
}

// 替换叶子节点（用于 split）— 返回新树
export function replaceNode(tree, targetId, replacement) {
  if (!tree) return tree;
  if (tree.type === 'pane') {
    return tree.terminalId === targetId ? replacement : tree;
  }
  return {
    ...tree,
    first: replaceNode(tree.first, targetId, replacement),
    second: replaceNode(tree.second, targetId, replacement)
  };
}

// 移除叶子节点，提升兄弟 — 返回新树或 null
export function removeNode(tree, targetId) {
  if (!tree) return null;
  if (tree.type === 'pane') {
    return tree.terminalId === targetId ? null : tree;
  }
  if (tree.first?.type === 'pane' && tree.first.terminalId === targetId) {
    return tree.second;
  }
  if (tree.second?.type === 'pane' && tree.second.terminalId === targetId) {
    return tree.first;
  }
  const newFirst = removeNode(tree.first, targetId);
  const newSecond = removeNode(tree.second, targetId);
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;
  return { ...tree, first: newFirst, second: newSecond };
}
