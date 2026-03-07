/**
 * findReplace — Find/Replace composable for CodeMirror editors.
 */

export function createFindReplace(activeFile) {
  const findBarVisible = Vue.ref(false);
  const replaceBarVisible = Vue.ref(false);
  const findQuery = Vue.ref('');
  const replaceQuery = Vue.ref('');
  const findCaseSensitive = Vue.ref(false);
  const findUseRegex = Vue.ref(false);
  const findMatchCount = Vue.ref(0);
  const findMatchIndex = Vue.ref(-1);
  const findInputRef = Vue.ref(null);
  const replaceInputRef = Vue.ref(null);
  let findMarkers = [];
  let findMatches = [];

  const clearScrollbarAnnotations = () => {
    const cm = activeFile.value?.cmInstance;
    if (!cm) return;
    const wrapper = cm.getWrapperElement();
    const existing = wrapper.querySelector('.cm-find-scrollbar-annotations');
    if (existing) existing.remove();
  };

  const updateScrollbarAnnotations = () => {
    const cm = activeFile.value?.cmInstance;
    if (!cm || findMatches.length === 0) return;
    clearScrollbarAnnotations();

    const wrapper = cm.getWrapperElement();
    const scrollbar = wrapper.querySelector('.CodeMirror-vscrollbar');
    if (!scrollbar) return;

    const totalLines = cm.lineCount();
    if (totalLines === 0) return;

    const container = document.createElement('div');
    container.className = 'cm-find-scrollbar-annotations';

    for (const m of findMatches) {
      const pct = (m.from.line / totalLines) * 100;
      const tick = document.createElement('div');
      tick.className = 'cm-find-scrollbar-tick';
      tick.style.top = pct + '%';
      container.appendChild(tick);
    }

    wrapper.appendChild(container);
  };

  const clearFindMarkers = () => {
    for (const m of findMarkers) {
      try { m.clear(); } catch (e) {}
    }
    findMarkers = [];
    findMatches = [];
    findMatchCount.value = 0;
    findMatchIndex.value = -1;
    clearScrollbarAnnotations();
  };

  const highlightCurrentMatch = (index) => {
    const cm = activeFile.value?.cmInstance;
    if (!cm || !findMatches[index]) return;
    for (let i = 0; i < findMarkers.length; i++) {
      if (!findMarkers[i]) continue;
      const pos = findMarkers[i].find();
      if (pos) {
        findMarkers[i].clear();
        findMarkers[i] = cm.markText(pos.from, pos.to, { className: 'cm-find-highlight' });
      }
    }
    const m = findMatches[index];
    if (findMarkers[index]) {
      const curPos = findMarkers[index].find();
      if (curPos) {
        findMarkers[index].clear();
        findMarkers[index] = cm.markText(curPos.from, curPos.to, { className: 'cm-find-highlight cm-find-current' });
      }
    }
    setTimeout(() => {
      cm.scrollIntoView({ from: m.from, to: m.to }, 100);
    }, 0);
  };

  const performFind = () => {
    clearFindMarkers();
    const cm = activeFile.value?.cmInstance;
    if (!cm || !findQuery.value) return;

    const query = findQuery.value;
    if (query.length < 3) return;

    const text = cm.getValue();
    const caseSensitive = findCaseSensitive.value;
    const useRegex = findUseRegex.value;
    const matches = [];

    try {
      if (useRegex) {
        const flags = caseSensitive ? 'g' : 'gi';
        const re = new RegExp(query, flags);
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          const from = cm.posFromIndex(m.index);
          const to = cm.posFromIndex(m.index + m[0].length);
          matches.push({ from, to });
          if (matches.length > 10000) break;
        }
      } else {
        const searchText = caseSensitive ? query : query.toLowerCase();
        const sourceText = caseSensitive ? text : text.toLowerCase();
        let idx = 0;
        while ((idx = sourceText.indexOf(searchText, idx)) !== -1) {
          const from = cm.posFromIndex(idx);
          const to = cm.posFromIndex(idx + query.length);
          matches.push({ from, to });
          idx += query.length;
          if (matches.length > 10000) break;
        }
      }
    } catch (e) {
      return;
    }

    findMatches = matches;
    findMatchCount.value = matches.length;

    for (const m of matches) {
      findMarkers.push(cm.markText(m.from, m.to, { className: 'cm-find-highlight' }));
    }

    if (matches.length > 0) {
      const cursor = cm.getCursor();
      let nearest = 0;
      for (let i = 0; i < matches.length; i++) {
        const cmp = CodeMirror.cmpPos(matches[i].from, cursor);
        if (cmp >= 0) { nearest = i; break; }
        if (i === matches.length - 1) nearest = 0;
      }
      findMatchIndex.value = nearest;
      highlightCurrentMatch(nearest);
    }

    updateScrollbarAnnotations();
  };

  const findNext = () => {
    if (findMatches.length === 0) return;
    const next = (findMatchIndex.value + 1) % findMatches.length;
    findMatchIndex.value = next;
    highlightCurrentMatch(next);
  };

  const findPrev = () => {
    if (findMatches.length === 0) return;
    const prev = (findMatchIndex.value - 1 + findMatches.length) % findMatches.length;
    findMatchIndex.value = prev;
    highlightCurrentMatch(prev);
  };

  const onFindInput = () => { performFind(); };

  const openFindBar = (showReplace = false) => {
    findBarVisible.value = true;
    replaceBarVisible.value = showReplace;
    const cm = activeFile.value?.cmInstance;
    if (cm) {
      const sel = cm.getSelection();
      if (sel) findQuery.value = sel;
    }
    Vue.nextTick(() => {
      findInputRef.value?.focus();
      findInputRef.value?.select();
      if (findQuery.value) performFind();
    });
  };

  const closeFindBar = () => {
    clearFindMarkers();
    findBarVisible.value = false;
    replaceBarVisible.value = false;
    const cm = activeFile.value?.cmInstance;
    if (cm) cm.focus();
  };

  const toggleReplaceBar = () => {
    replaceBarVisible.value = !replaceBarVisible.value;
    if (replaceBarVisible.value) {
      Vue.nextTick(() => replaceInputRef.value?.focus());
    }
  };

  const replaceOne = () => {
    const cm = activeFile.value?.cmInstance;
    if (!cm || findMatches.length === 0 || findMatchIndex.value < 0) return;
    const m = findMatches[findMatchIndex.value];
    cm.replaceRange(replaceQuery.value, m.from, m.to);
    performFind();
  };

  const replaceAll = () => {
    const cm = activeFile.value?.cmInstance;
    if (!cm || findMatches.length === 0) return;
    cm.operation(() => {
      for (let i = findMatches.length - 1; i >= 0; i--) {
        cm.replaceRange(replaceQuery.value, findMatches[i].from, findMatches[i].to);
      }
    });
    performFind();
  };

  return {
    findBarVisible, replaceBarVisible, findQuery, replaceQuery,
    findCaseSensitive, findUseRegex, findMatchCount, findMatchIndex,
    findInputRef, replaceInputRef,
    clearFindMarkers, performFind,
    onFindInput, findNext, findPrev,
    openFindBar, closeFindBar, toggleReplaceBar,
    replaceOne, replaceAll
  };
}
