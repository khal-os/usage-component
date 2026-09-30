/**
 * A position in the pending-price queue: the queue is read oldest first on
 * the (startedAt, traceId) tuple, and a cursor means "strictly after this
 * trace". Domain-owned because the reprocess use case hands it back to its
 * callers so a capped sweep can resume where it stopped (decision 183).
 */
export interface PendingPriceCursor {
  startedAt: Date;
  traceId: string;
}
