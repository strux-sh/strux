/**
 * useScreenStreams — bridges the device store's binary frame sink to jMuxer
 * decoder instances, one per streamed output.
 *
 * The view registers each <video> element (by its stream index) as it mounts;
 * incoming frames are routed to the matching decoder by output index.
 */
import { onBeforeUnmount } from "vue"
import JMuxer from "jmuxer"
import { useDeviceStore } from "@/stores/device"

interface Decoder {
  muxer: JMuxer
  video: HTMLVideoElement
}

export function useScreenStreams() {
    const store = useDeviceStore()
    const decoders = new Map<number, Decoder>()

    let frameCount = 0
    store.setFrameSink((outputIndex, h264) => {
        const decoder = decoders.get(outputIndex)
        frameCount++
        if (frameCount === 1) {
            console.info(`[strux-screen] first frame: index=${outputIndex}, ${h264.byteLength}B, decoder=${Boolean(decoder)}`)
        }
        if (!decoder && frameCount % 60 === 0) {
            console.warn(`[strux-screen] receiving frames for output index ${outputIndex} but no decoder registered (have: [${[...decoders.keys()].join(", ")}])`)
        }
        decoder?.muxer.feed({ video: h264 })
    })

    function registerVideo(index: number, video: HTMLVideoElement, fps: number): void {
        unregisterVideo(index)
        const muxer = new JMuxer({
            node: video,
            mode: "video",
            flushingTime: 0,
            fps: fps || 30,
            debug: false,
            onReady: () => console.info(`[strux-screen] jMuxer ready (output index ${index})`),
            onError: (err) => console.error(`[strux-screen] jMuxer error (output index ${index})`, err),
        })
        decoders.set(index, { muxer, video })
    }

    function unregisterVideo(index: number): void {
        const existing = decoders.get(index)
        if (!existing) return
        try {
            existing.muxer.destroy()
        } catch {
            /* already torn down */
        }
        decoders.delete(index)
    }

    onBeforeUnmount(() => {
        store.setFrameSink(null)
        for (const index of [...decoders.keys()]) unregisterVideo(index)
    })

    return { registerVideo, unregisterVideo }
}
