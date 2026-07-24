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


});
