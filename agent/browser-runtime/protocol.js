export const BROWSER_PROTOCOL_VERSION = 1;
export const BROWSER_CONTROL_CHANNEL = 'browser.control.v1';
export const BROWSER_POINTER_CHANNEL = 'browser.pointer.v1';
export const BROWSER_STATE_CHANNEL = 'browser.state.v1';

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Per-producer sequence fencing. Reliable control and lossy pointer traffic
 * intentionally have independent sequence spaces: pointer loss or reordering
 * must never advance or block reliable keyboard/click/navigation actions.
 */
export class ProducerSequenceState {
  /** @param {{producerId:string, producerGeneration:number}} identity */
  constructor({ producerId, producerGeneration }) {
    if (typeof producerId !== 'string' || !producerId) throw new Error('producerId required');
    if (!positiveInteger(producerGeneration)) throw new Error('producerGeneration must be a positive integer');
    this.producerId = producerId;
    this.producerGeneration = producerGeneration;
    this.lastAcceptedControlSeq = 0;
    this.lastAcceptedPointerSeq = 0;
  }

  #matches(envelope) {
    return envelope?.producerId === this.producerId
      && envelope?.producerGeneration === this.producerGeneration;
  }

  /**
   * Accept only the next gap-free reliable sequence number.
   * @returns {{accepted:boolean, code:string, expectedControlSeq:number}}
   */
  acceptControl(envelope) {
    const expectedControlSeq = this.lastAcceptedControlSeq + 1;
    if (!this.#matches(envelope)) return { accepted: false, code: 'producer_stale', expectedControlSeq };
    if (!positiveInteger(envelope.controlSeq)) return { accepted: false, code: 'control_seq_invalid', expectedControlSeq };
    if (envelope.controlSeq < expectedControlSeq) return { accepted: false, code: 'control_duplicate', expectedControlSeq };
    if (envelope.controlSeq > expectedControlSeq) return { accepted: false, code: 'control_gap', expectedControlSeq };
    this.lastAcceptedControlSeq = envelope.controlSeq;
    return { accepted: true, code: 'accepted', expectedControlSeq: this.lastAcceptedControlSeq + 1 };
  }

  /**
   * Accept any strictly newer lossy pointer sequence number. Gaps are expected.
   * @returns {{accepted:boolean, code:string, pointerHighWater:number}}
   */
  acceptPointer(envelope) {
    if (!this.#matches(envelope)) {
      return { accepted: false, code: 'producer_stale', pointerHighWater: this.lastAcceptedPointerSeq };
    }
    if (!positiveInteger(envelope.pointerSeq)) {
      return { accepted: false, code: 'pointer_seq_invalid', pointerHighWater: this.lastAcceptedPointerSeq };
    }
    if (envelope.pointerSeq <= this.lastAcceptedPointerSeq) {
      return { accepted: false, code: 'pointer_stale', pointerHighWater: this.lastAcceptedPointerSeq };
    }
    this.lastAcceptedPointerSeq = envelope.pointerSeq;
    return { accepted: true, code: 'accepted', pointerHighWater: this.lastAcceptedPointerSeq };
  }

  snapshot() {
    return Object.freeze({
      producerId: this.producerId,
      producerGeneration: this.producerGeneration,
      lastAcceptedControlSeq: this.lastAcceptedControlSeq,
      lastAcceptedPointerSeq: this.lastAcceptedPointerSeq,
    });
  }
}
