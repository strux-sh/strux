<template>
    <div class="h-screen flex flex-col bg-strux-bg font-strux-sans">

        <!-- ═══ Header ═══ -->
        <header class="flex items-center justify-between px-4 py-2 bg-strux-surface border-b border-strux-divider">
            <div class="flex items-center gap-3 font-strux-mono">
                <span class="text-strux-accent font-bold text-base tracking-[0.3em]">STRUX</span>
                <span class="text-strux-text-faint text-xs">//</span>
                <span class="text-strux-text-dim text-strux-label uppercase tracking-strux-label">Remote Display</span>
            </div>
            <div class="flex items-center gap-3">
                <Badge :variant="connectionVariant">{{ connectionLabel }}</Badge>
            </div>
        </header>

        <!-- ═══ Body ═══ -->
        <div class="flex-1 flex overflow-hidden">

            <!-- ─── Output rail ─── -->
            <aside class="w-64 border-r border-strux-divider bg-strux-bg flex flex-col">
                <div class="px-3 py-2 flex items-center gap-2 border-b border-strux-divider font-strux-mono">
                    <span class="text-strux-accent text-xs">&#x2502;</span>
                    <span class="text-strux-label font-medium uppercase tracking-strux-label text-strux-text-dim">Outputs</span>
                </div>

                <div v-if="!store.deviceConnected" class="p-4 text-strux-text-faint text-xs">
                    Waiting for device connection…
                </div>
                <div v-else-if="store.outputs.length === 0" class="p-4 text-strux-text-faint text-xs">
                    No outputs detected on device.
                </div>

                <ul v-else class="px-1.5 py-2 space-y-0.5">
                    <li
                        v-for="output in store.outputs"
                        :key="output.name"
                        class="flex items-center justify-between gap-2 px-2.5 py-2 cursor-pointer border-l-2 transition-colors"
                        :class="output.name === focusedOutput
                            ? 'bg-strux-accent/10 border-strux-accent text-strux-text'
                            : 'border-transparent text-strux-text-dim hover:bg-strux-surface'"
                        @click="focusOutput(output.name)"
                    >
                        <span class="flex items-center gap-2 min-w-0">
                            <span class="h-1.5 w-1.5 rounded-full shrink-0" :class="dotClass(output.name)" />
                            <span class="text-sm truncate">{{ output.label || output.name }}</span>
                        </span>
                        <Button
                            v-if="streamAction(output.name) === 'start'"
                            variant="secondary"
                            size="sm"
                            @click.stop="store.startStream(output.name)"
                        >Stream</Button>
                        <Button
                            v-else-if="streamAction(output.name) === 'stop'"
                            variant="ghost"
                            size="sm"
                            @click.stop="store.stopStream(output.name)"
                        >Stop</Button>
                        <span
                            v-else
                            class="text-strux-label font-strux-mono uppercase tracking-strux-label text-strux-text-faint px-1"
                        >{{ store.streams[output.name]?.status }}…</span>
                    </li>
                </ul>
            </aside>

            <!-- ─── Stage ─── -->
            <main class="flex-1 flex flex-col overflow-hidden">

                <!-- Stage toolbar -->
                <div class="flex items-center justify-between px-4 py-2 border-b border-strux-divider bg-strux-surface/40">
                    <div class="flex items-center gap-3 text-xs font-strux-mono">
                        <span class="text-strux-text-dim uppercase tracking-strux-label">{{ focusedOutput || '—' }}</span>
                        <span v-if="focusedStream?.status === 'streaming'" class="text-strux-text-faint">
                            {{ focusedStream?.width }}×{{ focusedStream?.height }} · {{ focusedStream?.encoder }} · {{ focusedStream?.fps }}fps
                        </span>
                    </div>
                    <div class="flex items-center gap-3">
                        <label class="flex items-center gap-2 cursor-pointer select-none">
                            <Switch v-model="inputEnabled" :disabled="focusedStream?.status !== 'streaming'" size="sm" />
                            <span class="text-xs uppercase tracking-strux-label font-strux-mono" :class="inputEnabled ? 'text-strux-ok' : 'text-strux-text-faint'">Input</span>
                        </label>
                        <Button
                            variant="secondary"
                            size="sm"
                            :disabled="focusedStream?.status !== 'streaming'"
                            @click="store.takeScreenshot(focusedOutput)"
                        >Screenshot</Button>
                    </div>
                </div>

                <!-- Stage content -->
                <div class="flex-1 flex items-center justify-center p-4 overflow-hidden bg-strux-bg dot-grid">

                    <div v-if="!focusedStream" class="text-strux-text-faint text-sm text-center">
                        Select an output to start streaming.
                    </div>

                    <div v-else-if="focusedStream?.status === 'starting'" class="flex flex-col items-center gap-3 text-strux-text-dim">
                        <Spinner label="Starting stream…" />
                        <span class="text-xs uppercase tracking-strux-label font-strux-mono">Starting {{ focusedOutput }}…</span>
                    </div>

                    <div v-else-if="focusedStream?.status === 'stopping'" class="flex flex-col items-center gap-3 text-strux-text-dim">
                        <Spinner label="Stopping stream…" />
                        <span class="text-xs uppercase tracking-strux-label font-strux-mono">Stopping {{ focusedOutput }}…</span>
                    </div>

                    <div v-else-if="focusedStream?.status === 'stopped'" class="flex flex-col items-center gap-2 text-strux-text-faint text-sm">
                        <span>Stream stopped on device.</span>
                        <Button variant="secondary" size="sm" @click="store.startStream(focusedOutput)">Stream again</Button>
                    </div>

                    <div v-else-if="focusedStream?.status === 'error'" class="text-strux-danger text-sm text-center max-w-md">
                        Stream error on {{ focusedOutput }}:
                        <div class="text-strux-text-dim mt-1">{{ focusedStream?.error }}</div>
                    </div>

                    <div
                        v-show="focusedStream?.status === 'streaming'"
                        class="relative bg-black border rounded-strux-md overflow-hidden max-w-full max-h-full transition-shadow"
                        :class="inputEnabled ? 'border-strux-ok ring-2 ring-strux-ok/50' : 'border-strux-divider'"
                    >
                        <video
                            ref="videoRef"
                            autoplay
                            muted
                            playsinline
                            tabindex="0"
                            draggable="false"
                            class="block max-w-full outline-none select-none"
                            :class="inputEnabled ? 'cursor-none' : 'cursor-default'"
                            style="max-height: calc(100vh - 9rem)"
                        />
                        <!-- Local virtual cursor: frames are captured without the
                             device cursor, so the viewer draws its own. Position
                             comes from the input composable, so it always matches
                             what was sent to the device. -->
                        <svg
                            v-if="inputEnabled && pointerPos"
                            class="absolute pointer-events-none z-10"
                            :style="{ left: `${pointerPos.x}px`, top: `${pointerPos.y}px` }"
                            width="18"
                            height="18"
                            viewBox="0 0 18 18"
                        >
                            <path
                                d="M2 1 L2 14 L5.5 10.8 L7.8 15.6 L10 14.6 L7.7 9.9 L12.2 9.4 Z"
                                fill="#fff"
                                stroke="#000"
                                stroke-width="1.1"
                            />
                        </svg>
                        <span class="absolute top-2 left-2 text-strux-label font-strux-mono bg-black/70 px-2 py-0.5 rounded-strux-sm text-strux-text-dim">{{ focusedOutput }}</span>
                        <span
                            v-if="inputEnabled"
                            class="absolute bottom-2 right-2 text-strux-label font-strux-mono bg-strux-ok/10 text-strux-ok px-2 py-0.5 rounded-strux-sm uppercase tracking-strux-label"
                        >Input captured · Esc to release</span>
                    </div>
                </div>
            </main>
        </div>

        <!-- ═══ Screenshot overlay ═══ -->
        <div
            v-if="store.screenshot"
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 cursor-pointer p-8"
            @click="store.clearScreenshot()"
        >
            <img
                :src="`data:image/jpeg;base64,${store.screenshot.data}`"
                class="max-w-[90vw] max-h-[90vh] border border-strux-divider rounded-strux-md"
                alt="Device screenshot"
            >
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { Badge, Button, Spinner, Switch } from "@strux-sh/ui"
import { useDeviceStore } from "@/stores/device"
import { useScreenStreams } from "@/composables/useScreenStreams"
import { useInputCapture } from "@/composables/useInputCapture"

const store = useDeviceStore()
const streams = useScreenStreams()

const focusedOutput = ref("")
const videoRef = ref<HTMLVideoElement | null>(null)
const inputEnabled = ref(false)

const focusedStream = computed(() => (focusedOutput.value ? store.streams[focusedOutput.value] : undefined))

const connectionLabel = computed(() => {
    if (store.status !== "connected") return "Disconnected"
    return store.deviceConnected ? "Online" : "No device"
})
const connectionVariant = computed(() => {
    if (store.status !== "connected") return "destructive" as const
    return store.deviceConnected ? ("ok" as const) : ("warn" as const)
})

function streamAction(name: string): "start" | "stop" | "busy" {
    const s = store.streams[name]?.status
    if (s === "streaming") return "stop"
    if (s === "starting" || s === "stopping") return "busy"
    return "start"
}

function dotClass(name: string): string {
    const s = store.streams[name]?.status
    if (s === "streaming") return "bg-strux-ok"
    if (s === "starting" || s === "stopping") return "bg-strux-warn animate-pulse"
    if (s === "error") return "bg-strux-danger"
    return "bg-strux-text-faint"
}

function focusOutput(name: string): void {
    focusedOutput.value = name
    if (!store.streams[name]) store.startStream(name)
}


// (Re)bind the jMuxer decoder to the single stage <video> as focus changes.
watch(
    () => [focusedStream.value?.outputName, focusedStream.value?.status, focusedStream.value?.index] as const,
    (_now, prev) => {
        if (prev && typeof prev[2] === "number" && prev[2] >= 0) streams.unregisterVideo(prev[2])
        inputEnabled.value = false
        nextTick(() => {
            const s = focusedStream.value
            if (s && s.status === "streaming" && videoRef.value) {
                streams.registerVideo(s.index, videoRef.value, s.fps)
            }
        })
    }
)

// Release input capture on Escape.
function onEscape(e: KeyboardEvent): void {
    if (e.key === "Escape") inputEnabled.value = false
}

const { pointerPos } = useInputCapture({
    target: videoRef,
    outputName: () => focusedOutput.value,
    enabled: inputEnabled,
    send: store.send,
})

onMounted(() => {
    store.init()
    window.addEventListener("keydown", onEscape)
})
</script>
