import { u8ToBase64, base64ToU8 } from './base64'

/**
 * Chunked, flow-controlled asset transfers (inner protocol v2 — see
 * docs/NETWORKING.md §7). Direction-agnostic: the same two classes run a
 * guest upload (guest → host) and a host serve (host → guest); only who
 * holds which end differs.
 *
 * Flow control is credit-based: the sender keeps at most
 * TRANSFER_WINDOW_CHUNKS un-credited chunks in flight, so a slow or
 * reconnecting peer never forces unbounded buffering anywhere — and small
 * op/presence messages always find gaps to interleave into.
 */

export const ASSET_CHUNK_BYTES = 256 * 1024
export const TRANSFER_WINDOW_CHUNKS = 4

export interface TransferMeta {
  readonly assetId: string
  readonly name: string
  readonly kind: 'audio' | 'midi'
  readonly ext: string
  /** Total encoded size in bytes. */
  readonly size: number
}

export type AssetTransferMessage =
  | {
      t: 'asset-begin'
      transferId: string
      meta: TransferMeta
      chunkCount: number
      /** First chunk index actually sent (resume support; 0 for fresh transfers). */
      startIndex: number
    }
  | { t: 'asset-chunk'; transferId: string; index: number; bytesBase64: string }
  | { t: 'asset-done'; transferId: string }
  /** Receiver → sender: all chunks up to and including this index arrived. */
  | { t: 'asset-credit'; transferId: string; upToIndex: number }
  | { t: 'asset-cancel'; transferId: string }

/** Sending half. Paces chunks by receiver credits; done after the last chunk. */
export class OutgoingTransfer {
  private nextIndex: number
  private creditedUpTo: number
  private readonly chunkCount: number
  private finished = false

  constructor(
    readonly transferId: string,
    readonly meta: TransferMeta,
    private bytes: Uint8Array,
    startByte: number,
    private send: (message: AssetTransferMessage) => void,
    private onFinish?: () => void
  ) {
    this.chunkCount = Math.max(1, Math.ceil(bytes.length / ASSET_CHUNK_BYTES))
    const startIndex = Math.min(
      Math.floor(Math.max(0, startByte) / ASSET_CHUNK_BYTES),
      this.chunkCount - 1
    )
    this.nextIndex = startIndex
    this.creditedUpTo = startIndex - 1
  }

  get done(): boolean {
    return this.finished
  }

  start(): void {
    this.send({
      t: 'asset-begin',
      transferId: this.transferId,
      meta: this.meta,
      chunkCount: this.chunkCount,
      startIndex: this.nextIndex
    })
    this.pump()
  }

  onCredit(upToIndex: number): void {
    if (this.finished) return
    this.creditedUpTo = Math.max(this.creditedUpTo, upToIndex)
    this.pump()
  }

  cancel(): void {
    if (this.finished) return
    this.finished = true
    this.send({ t: 'asset-cancel', transferId: this.transferId })
  }

  /** Peer cancelled or vanished — stop without echoing a cancel back. */
  abort(): void {
    this.finished = true
  }

  private pump(): void {
    while (
      !this.finished &&
      this.nextIndex < this.chunkCount &&
      this.nextIndex <= this.creditedUpTo + TRANSFER_WINDOW_CHUNKS
    ) {
      const from = this.nextIndex * ASSET_CHUNK_BYTES
      const chunk = this.bytes.subarray(from, Math.min(this.bytes.length, from + ASSET_CHUNK_BYTES))
      this.send({
        t: 'asset-chunk',
        transferId: this.transferId,
        index: this.nextIndex,
        bytesBase64: u8ToBase64(chunk)
      })
      this.nextIndex += 1
    }
    if (!this.finished && this.nextIndex >= this.chunkCount) {
      this.finished = true
      this.send({ t: 'asset-done', transferId: this.transferId })
      this.onFinish?.()
    }
  }
}

export interface IncomingTransferCallbacks {
  onProgress?(receivedBytes: number, totalBytes: number): void
  onComplete(bytes: Uint8Array): void
  onError?(reason: string): void
}

/** Receiving half. Assembles chunks, credits the sender, verifies size. */
export class IncomingTransfer {
  private buffer: Uint8Array
  private received: Set<number> = new Set()
  private readonly chunkCount: number
  private finished = false

  constructor(
    readonly transferId: string,
    readonly meta: TransferMeta,
    beginChunkCount: number,
    startIndex: number,
    /** Partial bytes already held from an interrupted transfer (resume). */
    partial: Uint8Array | null,
    private send: (message: AssetTransferMessage) => void,
    private callbacks: IncomingTransferCallbacks
  ) {
    this.chunkCount = beginChunkCount
    this.buffer = new Uint8Array(meta.size)
    if (partial) this.buffer.set(partial.subarray(0, meta.size), 0)
    // Chunks below startIndex are covered by the partial prefix.
    for (let i = 0; i < startIndex; i++) this.received.add(i)
  }

  get done(): boolean {
    return this.finished
  }

  /** Contiguous received prefix in bytes — what a resume can skip. */
  get haveBytes(): number {
    let index = 0
    while (this.received.has(index)) index += 1
    return Math.min(this.meta.size, index * ASSET_CHUNK_BYTES)
  }

  /** Current partial buffer, for stashing across a disconnect. */
  get partialBytes(): Uint8Array {
    return this.buffer.subarray(0, this.haveBytes)
  }

  onChunk(index: number, bytesBase64: string): void {
    if (this.finished || index < 0 || index >= this.chunkCount || this.received.has(index)) return
    const bytes = base64ToU8(bytesBase64)
    this.buffer.set(bytes.subarray(0, this.meta.size - index * ASSET_CHUNK_BYTES), index * ASSET_CHUNK_BYTES)
    this.received.add(index)
    this.send({ t: 'asset-credit', transferId: this.transferId, upToIndex: index })
    this.callbacks.onProgress?.(this.haveBytes, this.meta.size)
  }

  onDone(): void {
    if (this.finished) return
    this.finished = true
    if (this.received.size !== this.chunkCount) {
      this.callbacks.onError?.(
        `Transfer ended with ${this.received.size}/${this.chunkCount} chunks`
      )
      return
    }
    this.callbacks.onComplete(this.buffer)
  }

  cancel(): void {
    if (this.finished) return
    this.finished = true
    this.send({ t: 'asset-cancel', transferId: this.transferId })
  }

  abort(): void {
    this.finished = true
  }
}
