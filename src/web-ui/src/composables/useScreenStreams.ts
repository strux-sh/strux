/**
 * useScreenStreams — routes the device store's binary H.264 frames into a
 * decoder, one per streamed output.
 *
 * Decode path is WebCodecs-first: frames go straight into a hardware
 * VideoDecoder (optimizeForLatency) and paint onto a <canvas> — no container,
 * no MSE playout buffer. Browsers without H.264 WebCodecs support fall back
 * to jMuxer + MSE on the <video> element, as does any stream whose config or
 * decode errors out.
 *
 * Per-stream stats (fps, bitrate, queue lag, drops) are exposed reactively
 * for the latency HUD. Queue lag is measured as the drift of
 * (arrival time - capture time) above its best-case over a sliding window —
 * epoch-agnostic, so device and browser clocks never need to be synced.
 */
import { onBeforeUnmount, reactive } from "vue"
import JMuxer from "jmuxer"
import { useDeviceStore } from "@/stores/device"
import type { OutputTransform } from "@/lib/protocol"
import { drawTransformed, transformedSize } from "@/lib/output-transform"

export type DecodeMode = "webcodecs" | "jmuxer"

export interface StreamStats {
  mode: DecodeMode | null
  fps: number
  kbps: number
  /** ms of queueing above the best-case pipeline latency (relative measure) */
  queueMs: number | null
  /**
   * Rate at which device capture timestamps advance vs. wall clock over the
   * window. ~1.0 is healthy; below 1.0 means the device is stamping frames
   * slower than real time (and queueMs readings are then inflated).
   */
  clock: number | null
  decodeQueue: number
  dropped: number
}

interface Sink {
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  fps: number
  transform: OutputTransform
  mode: DecodeMode | null
  muxer: JMuxer | null
  decoder: VideoDecoder | null
  ctx: CanvasRenderingContext2D | null
  /** frames buffered while awaiting async config support check */
  pending: { data: Uint8Array; tsUs: number; keyframe: boolean }[] | null
  latestFrame: VideoFrame | null
  rafQueued: boolean
  // stats accumulators (flushed to `stats` at 2 Hz)
  frames: number
  bytes: number
  dropped: number
  offsets: { t: number; offset: number; cap: number }[]
  lastOffset: number | null
}

const OFFSET_WINDOW_MS = 10_000
const STATS_FLUSH_MS = 500

/** Extract "avc1.PPCCLL" from the first SPS NAL in an Annex-B keyframe. */
function h264CodecString(annexb: Uint8Array): string | null {
    for (let i = 0; i + 4 < annexb.length; i++) {
        if (annexb[i] !== 0 || annexb[i + 1] !== 0) continue
        const off = annexb[i + 2] === 1 ? i + 3 : (annexb[i + 2] === 0 && annexb[i + 3] === 1 ? i + 4 : 0)
        if (off === 0) continue
        const nalType = annexb[off]! & 0x1f
        if (nalType === 7 && off + 3 < annexb.length) {
            const hex = (b: number) => b.toString(16).padStart(2, "0").toUpperCase()
            return `avc1.${hex(annexb[off + 1]!)}${hex(annexb[off + 2]!)}${hex(annexb[off + 3]!)}`
        }
        i = off
    }
    return null
}

export function useScreenStreams() {
    const store = useDeviceStore()
    const sinks = new Map<number, Sink>()
    const stats = reactive<Record<number, StreamStats>>({})

    const webCodecsAvailable = typeof VideoDecoder !== "undefined"

    // --- WebCodecs path ---

    function paintLatest(sink: Sink): void {
        sink.rafQueued = false
        const frame = sink.latestFrame
        if (!frame) return
        sink.latestFrame = null
        const size = transformedSize(frame.displayWidth, frame.displayHeight, sink.transform)
        if (sink.canvas.width !== size.width) sink.canvas.width = size.width
        if (sink.canvas.height !== size.height) sink.canvas.height = size.height
        sink.ctx ??= sink.canvas.getContext("2d")
        if (sink.ctx) {
            drawTransformed(sink.ctx, frame, frame.displayWidth, frame.displayHeight, sink.transform)
        }
        frame.close()
    }

    function startWebCodecs(sink: Sink, index: number, codec: string): void {
        const decoder = new VideoDecoder({
            output: (frame) => {
                if (sink.latestFrame) {
                    // Renderer is behind — show only the newest frame
                    sink.latestFrame.close()
                    sink.dropped++
                }
                sink.latestFrame = frame
                if (!sink.rafQueued) {
                    sink.rafQueued = true
                    requestAnimationFrame(() => paintLatest(sink))
                }
            },
            error: (err) => {
                console.warn(`[strux-screen] WebCodecs error (output ${index}), falling back to jMuxer`, err)
                fallbackToJmuxer(sink, index)
            },
        })
        decoder.configure({ codec, optimizeForLatency: true })
        sink.decoder = decoder
        sink.mode = "webcodecs"
    }

    function decodeChunk(sink: Sink, data: Uint8Array, tsUs: number, keyframe: boolean): void {
        if (!sink.decoder || sink.decoder.state !== "configured") return
        sink.decoder.decode(new EncodedVideoChunk({
            type: keyframe ? "key" : "delta",
            timestamp: tsUs,
            data: data as BufferSource,
        }))
    }

    // --- jMuxer fallback ---

    function fallbackToJmuxer(sink: Sink, index: number): void {
        try {
            sink.decoder?.close()
        } catch { /* already closed */ }
        sink.decoder = null
        sink.latestFrame?.close()
        sink.latestFrame = null
        sink.mode = "jmuxer"
        sink.muxer = new JMuxer({
            node: sink.video,
            mode: "video",
            flushingTime: 0,
            fps: sink.fps || 30,
            debug: false,
            onError: (err) => console.error(`[strux-screen] jMuxer error (output ${index})`, err),
        })
    }

    // --- Frame routing ---

    store.setFrameSink((outputIndex, h264, captureMs, keyframe) => {
        const sink = sinks.get(outputIndex)
        if (!sink) return

        // Stats: arrival offset vs capture time (relative clocks)
        const now = performance.now()
        sink.frames++
        sink.bytes += h264.byteLength
        if (captureMs > 0) {
            const offset = now - captureMs
            sink.lastOffset = offset
            sink.offsets.push({ t: now, offset, cap: captureMs })
            while (sink.offsets.length > 0 && sink.offsets[0]!.t < now - OFFSET_WINDOW_MS) sink.offsets.shift()
        }

        const tsUs = Math.round(captureMs * 1000)

        // Mode not decided yet: needs a keyframe (for SPS) to pick a path
        if (sink.mode === null) {
            if (sink.pending) {
                // Config check in flight — keep the decodable chain intact
                sink.pending.push({ data: h264.slice(), tsUs, keyframe })
                return
            }
            if (!keyframe) return // undecodable until a keyframe arrives

            if (!webCodecsAvailable) {
                fallbackToJmuxer(sink, outputIndex)
                sink.muxer?.feed({ video: h264 })
                return
            }

            const codec = h264CodecString(h264)
            if (!codec) {
                // Keyframe without in-band SPS (encoder didn't repeat headers).
                // No decoder can start from this — wait for a keyframe that
                // carries them rather than falling back to a broken path.
                console.warn(`[strux-screen] keyframe without SPS on output ${outputIndex}; waiting for headers`)
                return
            }

            sink.pending = [{ data: h264.slice(), tsUs, keyframe }]
            VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true })
                .then((res) => {
                    const pending = sink.pending ?? []
                    sink.pending = null
                    if (res.supported) {
                        console.info(`[strux-screen] WebCodecs decode (${codec}) for output ${outputIndex}`)
                        startWebCodecs(sink, outputIndex, codec)
                        for (const f of pending) decodeChunk(sink, f.data, f.tsUs, f.keyframe)
                    } else {
                        console.info(`[strux-screen] WebCodecs unsupported for ${codec}; using jMuxer`)
                        fallbackToJmuxer(sink, outputIndex)
                        for (const f of pending) sink.muxer?.feed({ video: f.data })
                    }
                })
                .catch(() => {
                    const pending = sink.pending ?? []
                    sink.pending = null
                    fallbackToJmuxer(sink, outputIndex)
                    for (const f of pending) sink.muxer?.feed({ video: f.data })
                })
            return
        }

        if (sink.mode === "webcodecs") {
            decodeChunk(sink, h264, tsUs, keyframe)
        } else {
            sink.muxer?.feed({ video: h264 })
        }
    })

    // --- Stats flushing ---

    const statsTimer = setInterval(() => {
        for (const [index, sink] of sinks) {
            const scale = 1000 / STATS_FLUSH_MS
            let queueMs: number | null = null
            let clock: number | null = null
            if (sink.lastOffset !== null && sink.offsets.length > 1) {
                let min = Infinity
                for (const o of sink.offsets) min = Math.min(min, o.offset)
                queueMs = Math.max(0, sink.lastOffset - min)
                const first = sink.offsets[0]!
                const last = sink.offsets[sink.offsets.length - 1]!
                const wallSpan = last.t - first.t
                if (wallSpan > 2000) clock = (last.cap - first.cap) / wallSpan
            }
            stats[index] = {
                mode: sink.mode,
                fps: Math.round(sink.frames * scale),
                kbps: Math.round((sink.bytes * 8 * scale) / 1000),
                queueMs,
                clock,
                decodeQueue: sink.decoder?.decodeQueueSize ?? 0,
                dropped: sink.dropped,
            }
            sink.frames = 0
            sink.bytes = 0
        }
    }, STATS_FLUSH_MS)

    // --- Registration ---

    function registerStream(
        index: number,
        els: { video: HTMLVideoElement; canvas: HTMLCanvasElement },
        fps: number,
        transform: OutputTransform
    ): void {
        unregisterStream(index)
        sinks.set(index, {
            video: els.video,
            canvas: els.canvas,
            fps,
            transform,
            mode: null,
            muxer: null,
            decoder: null,
            ctx: null,
            pending: null,
            latestFrame: null,
            rafQueued: false,
            frames: 0,
            bytes: 0,
            dropped: 0,
            offsets: [],
            lastOffset: null,
        })
    }

    function unregisterStream(index: number): void {
        const sink = sinks.get(index)
        if (!sink) return
        try {
            sink.muxer?.destroy()
        } catch { /* already torn down */ }
        try {
            sink.decoder?.close()
        } catch { /* already closed */ }
        sink.latestFrame?.close()
        sinks.delete(index)
        delete stats[index]
    }

    onBeforeUnmount(() => {
        store.setFrameSink(null)
        clearInterval(statsTimer)
        for (const index of [...sinks.keys()]) unregisterStream(index)
    })

    return { registerStream, unregisterStream, stats }
}
