import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('MessageList virtualization wiring', () => {
  it('routes Chat and Yeaft message blocks through the shared VirtualTranscript', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain("import VirtualTranscript from './VirtualTranscript.js';");
    expect(source).toContain('<VirtualTranscript');
    expect(source).toContain(':items="messageBlocks"');
    expect(source).toContain('initial-align="end"');
    expect(source).toContain(':key="virtualTranscriptIdentity"');
    expect(source).toContain("store.currentAgent || ''");
    expect(source).toContain("store.yeaftActiveSessionFilter || activeYeaftSessionId.value || '__all__'");
    expect(source).toContain('@scroll-state="onVirtualTranscriptScrollState"');
    expect(source).toContain('showInitialMessagesLoading');
    expect(source).toContain('initial-message-loading');
    expect(source).toContain('the following AI replies into one virtual item');
    expect(source).toContain('v-if="block.type === \'message-block\'"');
    expect(source).not.toContain('<template v-for="block in messageBlocks"');
  });

  it('keeps remounted assistant action and tool UI state keyed by turn id', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const assistantTurnActionStates = Vue.reactive({});');
    expect(source).toContain('const toolExpandStates = Vue.reactive({});');
    expect(source).toContain(':actions-expanded="assistantTurnActionsExpandedFor(block)"');
    expect(source).toContain(':tool-expand-states="toolExpandStates"');
    expect(source).toContain(':response-collapsible="responseToggleBelongsToItem(block, item)"');
    expect(source).toContain('@toggle-response-collapse="toggleMessageTurnResponse(block)"');
    expect(source).not.toContain('message-turn-collapse-toggle');
    expect(source).not.toContain('vpTurnExpandStates');
    expect(source).not.toContain(':expand-state="vpTurnExpandStateFor(block)"');
  });

  it('keeps load-more template handlers and loading state wired through setup', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('@click="onClickLoadMore"');
    expect(source).toContain('const onClickLoadMore = () => {');
    expect(source.match(/const onClickLoadMore = \(\) => \{/g)).toHaveLength(1);
    expect(source).toContain('onClickLoadMore,');
    expect(source).toContain('v-if="showSessionLoadingOverlay"');
    expect(source).toContain('!!store.sessionLoading && !showInitialMessagesLoading.value');
    expect(source).not.toContain('v-if="sessionLoading"');
  });

  it('auto-loads more messages from the virtual scroll near-top event', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const LOAD_MORE_TOP_THRESHOLD = 100;');
    expect(source).toContain('const maybeLoadMoreNearTop = (scrollTop, { allowContinuation = false } = {}) => {');
    expect(source).toContain('if (scrollTop > LOAD_MORE_TOP_THRESHOLD) {');
    expect(source).toContain('onClickLoadMore();');
    expect(source).toContain('maybeLoadMoreNearTop(scrollTop || 0);');
    expect(source).toContain('const continueLoadMoreIfStillNearTop = (beforeSnapshot) => {');
    expect(source).toContain('maybeLoadMoreNearTop(containerRef.value.scrollTop || 0, { allowContinuation: true });');
  });

  it('does not let virtual layout updates re-enable bottom following while reading history', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('isAtBottom.value = resolveTranscriptBottomFollow({');
    expect(source).toContain('following: !autoFollowPaused.value,');
    expect(source).toContain('userScroll: userScrollInteractionActive,');
    expect(source).toContain("containerRef.value.addEventListener('wheel', markUserScrollIntent, { passive: true });");
    expect(source).toContain("containerRef.value.addEventListener('touchmove', markUserScrollIntent, { passive: true });");
    expect(source).toContain("containerRef.value.addEventListener('pointerdown', onPointerScrollStart, { passive: true });");
    expect(source).toContain("window.addEventListener('pointerup', onPointerScrollEnd, { passive: true });");
    expect(source).toContain("window.addEventListener('pointercancel', onPointerScrollEnd, { passive: true });");
    expect(source).toContain("window.addEventListener('keydown', onScrollKey);");
    expect(source).toContain('if (!isTranscriptScrollbarPointer(event, containerRef.value)) return;');
    expect(source).toContain('if (shouldMarkTranscriptKeyScroll(event, containerRef.value)) markUserScrollIntent();');
    expect(source).not.toContain('USER_SCROLL_INTENT_WINDOW_MS');
    expect(source).not.toContain('isAtBottom.value = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;');
  });

  it('defers ResizeObserver measurements out of the observer callback', () => {
    const source = read('components/VirtualTranscript.js');

    expect(source).toContain('const pendingMeasurements = new Map();');
    expect(source).toContain('function scheduleMeasureElement(key, index, el) {');
    expect(source).toContain('requestAnimationFrame(() => {');
    expect(source).toContain('commitMeasurements(entries);');
    expect(source).toContain('if (key) scheduleMeasureElement(key, index, entry.target);');
    expect(source).toContain('const HEIGHT_CHANGE_THRESHOLD = 2;');
    expect(source).toContain('const windowStart = virtualWindow.value.visibleStart;');
    expect(source).toContain('function scheduleScrollAdjustment({ delta = 0, toBottom = false } = {}) {');
    expect(source).not.toContain('if (key) measureElement(key, index, entry.target);');
  });

  it('caches item offsets outside the scroll-dependent virtual window', () => {
    const source = read('components/VirtualTranscript.js');

    expect(source).toContain('const virtualLayout = Vue.computed(() => buildVirtualOffsets(');
    expect(source).toContain('computeVirtualWindowFromLayout(props.items, virtualLayout.value, {');
    expect(source).not.toContain('computeVirtualWindow(props.items, {');
  });


  it('requires load-more progress before continuing while pinned near top', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const beforeSnapshot = getLoadMoreProgressSnapshot();');
    expect(source).toContain('if (!hasLoadMoreProgress(beforeSnapshot, afterSnapshot)) return;');
    expect(source).toContain('continueLoadMoreIfStillNearTop(beforeSnapshot);');
    expect(source).not.toContain('continueLoadMoreIfStillNearTop();');
  });

  it('aligns Chat auto load-more guard with the action guard', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('return !!store.currentConversation && store.hasMoreMessages && !store.loadingMoreMessages;');
  });

  it('keeps Yeaft auto-follow scoped to the visible session tail and explicit resume intents', () => {
    const source = read('components/MessageList.js');

    expect(source).toContain('const autoFollowPaused = Vue.ref(false);');
    expect(source).toContain('const SCROLL_THRESHOLD = virtualTranscriptDefaults.bottomThreshold;');
    expect(source).toContain('shouldFollowTranscriptBottom({ scrollTop, scrollHeight, clientHeight, threshold: SCROLL_THRESHOLD });');
    expect(source).toContain('const visibleTranscriptTailSignature = Vue.computed(() => {');
    expect(source).toContain('Vue.watch(visibleTranscriptTailSignature, smartScrollToBottom);');
    expect(source).not.toContain('Vue.watch(() => store.messages.length, smartScrollToBottom);');
    expect(source).not.toContain('Vue.watch(() => store.messages[store.messages.length - 1]?.content, smartScrollToBottom);');
    expect(source).toContain('() => [store.activeConversationId, activeYeaftSessionId.value]');
    expect(source).not.toContain('() => [store.currentConversation, activeYeaftSessionId.value]');
    expect(source).toContain('resumeAutoFollow();');
  });

});
