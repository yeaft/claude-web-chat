/**
 * diffParser — unified diff parser for side-by-side rendering.
 */

export function parseDiff(diffText, newFileContent, t) {
  const result = [];
  let additions = 0;
  let deletions = 0;

  if (newFileContent != null) {
    const fileLines = newFileContent.split('\n');
    for (let i = 0; i < fileLines.length; i++) {
      result.push({ type: 'addition', oldNum: '', oldText: '', newNum: i + 1, newText: fileLines[i] });
      additions++;
    }
    return { lines: result, stats: { additions, deletions: 0 }, content: newFileContent };
  }

  if (!diffText || diffText.trim() === '') {
    return {
      lines: [{ type: 'context', oldNum: '', oldText: t('git.noDiff'), newNum: '', newText: t('git.noDiff') }],
      stats: { additions: 0, deletions: 0 },
      content: ''
    };
  }

  // Binary file detection
  if (diffText.includes('Binary files') && diffText.includes('differ')) {
    return {
      lines: [{ type: 'context', oldNum: '', oldText: t('git.binaryFile'), newNum: '', newText: t('git.binaryFile') }],
      stats: { additions: 0, deletions: 0 },
      content: diffText
    };
  }

  const rawLines = diffText.split('\n');
  let oldLine = 0, newLine = 0, inHunk = false;
  let delBuf = [], addBuf = [];

  const flush = () => {
    const max = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < max; i++) {
      const d = delBuf[i], a = addBuf[i];
      if (d && a) {
        result.push({ type: 'modification', oldNum: d.num, oldText: d.text, newNum: a.num, newText: a.text });
      } else if (d) {
        result.push({ type: 'deletion', oldNum: d.num, oldText: d.text, newNum: '', newText: '' });
      } else if (a) {
        result.push({ type: 'addition', oldNum: '', oldText: '', newNum: a.num, newText: a.text });
      }
    }
    delBuf = [];
    addBuf = [];
  };

  for (const raw of rawLines) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') ||
        raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('\\')) continue;

    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      flush();
      oldLine = parseInt(hunkMatch[1]);
      newLine = parseInt(hunkMatch[2]);
      inHunk = true;
      result.push({ type: 'hunk', oldNum: '···', oldText: raw, newNum: '···', newText: raw });
      continue;
    }

    if (!inHunk) continue;

    if (raw.startsWith('-')) {
      if (addBuf.length > 0 && delBuf.length === 0) flush();
      delBuf.push({ num: oldLine++, text: raw.substring(1) });
      deletions++;
    } else if (raw.startsWith('+')) {
      addBuf.push({ num: newLine++, text: raw.substring(1) });
      additions++;
    } else {
      flush();
      const text = raw.startsWith(' ') ? raw.substring(1) : raw;
      result.push({ type: 'context', oldNum: oldLine++, oldText: text, newNum: newLine++, newText: text });
    }
  }
  flush();

  return { lines: result, stats: { additions, deletions }, content: diffText };
}
