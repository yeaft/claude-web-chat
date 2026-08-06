import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('MessageList virtualization wiring', () => {






  it('auto-loads more messages from the virtual scroll near-top event', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('historyPrefetchThreshold,');
    expect(source).toContain('const maybeLoadMoreNearTop = (scrollTop, clientHeight = 0, { allowContinuation = false } = {}) => {');
    expect(source).toContain('if (scrollTop > historyPrefetchThreshold(clientHeight)) {');
    expect(source).toContain('onClickLoadMore();');
    expect(source).toContain('maybeLoadMoreNearTop(scrollTop || 0, clientHeight || 0);');
    expect(source).toContain('const continueLoadMoreIfStillNearTop = (beforeSnapshot) => {');
    expect(source).toContain('containerRef.value.clientHeight || 0,');
    expect(source).toContain('{ allowContinuation: true },');
  });














  it('pauses bottom following before targeted history navigation', () => {
    const messageList = read('components/MessageList.js');
    const transcript = read('components/VirtualTranscript.js');

    expect(messageList).toContain('const pauseAutoFollow = () => {');
    expect(messageList).toContain('const markUserScrollIntent = () => {\n      pauseAutoFollow();');
    expect(messageList).toContain('const onPointerScrollStart = (event) => {\n      if (!isTranscriptScrollbarPointer(event, containerRef.value)) return;\n      pauseAutoFollow();');
    expect(messageList).toContain('const onScrollKey = (event) => {\n      if (!shouldMarkTranscriptKeyScroll(event, containerRef.value)) return;\n      pauseAutoFollow();');
    expect(messageList).not.toContain('resumeBoundaryReached: reachedBottom,');
    expect(messageList).toContain('const scrollToLatest = () => {');
    expect(messageList).toContain('clearUserScrollInteraction();\n      resumeAutoFollow();\n      Vue.nextTick(scrollToBottom);');
    expect(messageList).toContain('virtualTranscriptRef.value?.cancelPendingBottomFollow?.();');
    expect(messageList).toContain('const revealMessage = async (target) => {\n      if (!target) return false;\n      pauseAutoFollow();');
    expect(messageList).not.toContain('scrollToBlock: (blockId) => {\n          resumeAutoFollow();');
    expect(transcript).toContain('function cancelPendingBottomFollow({ preserveTarget = false } = {}) {');
    expect(transcript).toContain('pendingScrollToBottom = false;');
    expect(transcript).toContain('expose({ scrollToKey, scrollToIndex, anchorTarget, clearTargetAnchor, cancelPendingBottomFollow, setBottomFollowEnabled });');
  });

});
