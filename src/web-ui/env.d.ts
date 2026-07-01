/// <reference types="vite/client" />

// CSS-only side-effect subpath exports from the design system.
declare module "@strux-sh/ui/fonts"
declare module "@strux-sh/ui/dist.css"

declare module "jmuxer" {
  interface JMuxerOptions {
    node: HTMLVideoElement | string
    mode?: "both" | "video" | "audio"
    flushingTime?: number
    maxDelay?: number
    clearBuffer?: boolean
    fps?: number
    debug?: boolean
    onReady?: () => void
    onError?: (error: unknown) => void
    onMissingVideoFrames?: (data: unknown) => void
    onMissingAudioFrames?: (data: unknown) => void
  }

  interface JMuxerFeed {
    video?: Uint8Array
    audio?: Uint8Array
    duration?: number
  }

  export default class JMuxer {
      constructor(options: JMuxerOptions)
      feed(data: JMuxerFeed): void
      reset(): void
      destroy(): void
  }
}
