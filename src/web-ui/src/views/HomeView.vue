<template>
    <div class="h-screen flex flex-col bg-strux-bg font-strux-sans">

        <!-- ═══ Header ═══ -->
        <header class="flex items-center justify-between px-4 py-2 bg-strux-surface border-b border-strux-divider">
            <div class="flex items-center gap-3 font-strux-mono">
                <span class="text-strux-accent font-bold text-base tracking-[0.3em]">STRUX</span>
                <span class="text-strux-text-faint text-xs">//</span>
                <span class="text-strux-text-dim text-strux-label uppercase tracking-strux-label">Mission Control</span>
            </div>
            <div class="flex items-center gap-3">
                <Badge :variant="buildBadge.variant">{{ buildBadge.label }}</Badge>
                <Badge :variant="connectionVariant">{{ connectionLabel }}</Badge>
                <Button variant="primary" size="sm" @click="router.push('/screen')">Remote Display</Button>
            </div>
        </header>

        <!-- ═══ Body ═══ -->
        <div class="flex-1 flex overflow-hidden">

            <!-- ─── Left rail: live cards ─── -->
            <aside class="w-[380px] shrink-0 border-r border-strux-divider overflow-auto p-4 space-y-4 reveal">

                <!-- Device -->
                <Card>
                    <CardHeader>
                        <CardTitle class="flex items-center gap-2">
                            <span class="h-2 w-2 rounded-full" :class="store.deviceConnected ? 'bg-strux-ok' : 'bg-strux-text-faint'" />
                            Device
                        </CardTitle>
                        <CardAction>
                            <Badge :variant="connectionVariant" size="sm">{{ store.deviceConnected ? 'Online' : 'Offline' }}</Badge>
                        </CardAction>
                    </CardHeader>
                    <CardContent>
                        <dl class="grid grid-cols-2 gap-y-3 gap-x-2 text-sm">
                            <div>
                                <dt class="text-strux-label uppercase tracking-strux-label text-strux-text-faint mb-0.5">BSP</dt>
                                <dd class="text-strux-text font-strux-mono">{{ store.deviceStatus.bspName || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-strux-label uppercase tracking-strux-label text-strux-text-faint mb-0.5">Arch</dt>
                                <dd class="text-strux-text font-strux-mono">{{ store.deviceStatus.arch || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-strux-label uppercase tracking-strux-label text-strux-text-faint mb-0.5">IP</dt>
                                <dd class="text-strux-text font-strux-mono">{{ store.deviceStatus.ip || '—' }}</dd>
                            </div>
                            <div>
                                <dt class="text-strux-label uppercase tracking-strux-label text-strux-text-faint mb-0.5">Client</dt>
                                <dd class="text-strux-text font-strux-mono">{{ store.deviceStatus.version ? `v${store.deviceStatus.version}` : '—' }}</dd>
                            </div>
                        </dl>
                    </CardContent>
                </Card>

                <!-- Outputs -->
                <Card>
                    <CardHeader>
                        <CardTitle>Outputs</CardTitle>
                        <CardAction>
                            <Badge variant="secondary" size="sm">{{ store.outputs.length }}</Badge>
                        </CardAction>
                    </CardHeader>
                    <CardContent>
                        <p v-if="store.outputs.length === 0" class="text-sm text-strux-text-faint">No outputs detected.</p>
                        <ul v-else class="space-y-1.5">
                            <li
                                v-for="output in store.outputs"
                                :key="output.name"
                                class="flex items-center justify-between text-sm cursor-pointer hover:text-strux-accent-bright transition-colors"
                                @click="router.push('/screen')"
                            >
                                <span class="flex items-center gap-2 font-strux-mono">
                                    <span class="h-1.5 w-1.5 rounded-full" :class="store.streams[output.name]?.status === 'streaming' ? 'bg-strux-ok' : 'bg-strux-text-faint'" />
                                    {{ output.label || output.name }}
                                </span>
                                <span class="text-strux-label uppercase tracking-strux-label text-strux-text-faint">
                                    {{ store.streams[output.name]?.status === 'streaming' ? 'Live' : 'View' }}
                                </span>
                            </li>
                        </ul>
                    </CardContent>
                </Card>

                <!-- Quick actions -->
                <Card>
                    <CardHeader>
                        <CardTitle>Quick Actions</CardTitle>
                    </CardHeader>
                    <CardContent class="space-y-2">
                        <Button variant="secondary" size="sm" class="w-full" :disabled="!store.deviceConnected" @click="store.restartStrux()">Restart Strux Service</Button>
                        <Button variant="destructive" size="sm" class="w-full" :disabled="!store.deviceConnected" @click="confirmReboot">Reboot Device</Button>
                    </CardContent>
                </Card>
            </aside>

            <!-- ─── Main: live logs ─── -->
            <main class="flex-1 flex flex-col overflow-hidden">
                <div class="flex items-center justify-between px-4 py-2 border-b border-strux-divider bg-strux-surface/40">
                    <div class="flex items-center gap-2 font-strux-mono">
                        <span class="text-strux-accent text-xs">&#x2502;</span>
                        <span class="text-strux-label uppercase tracking-strux-label text-strux-text-dim">Live Logs</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <Spinner v-if="store.buildState.state === 'building'" class="size-3.5" />
                        <span class="text-strux-label uppercase tracking-strux-label text-strux-text-faint">{{ store.logs.length }} lines</span>
                    </div>
                </div>

                <div ref="logEl" class="flex-1 overflow-auto p-3 font-strux-mono text-strux-mono leading-relaxed">
                    <p v-if="store.logs.length === 0" class="text-strux-text-faint">
                        Waiting for device logs…
                    </p>
                    <div
                        v-for="(log, i) in store.logs"
                        :key="i"
                        class="flex gap-2 hover:bg-strux-surface/40 px-1 -mx-1 rounded-strux-sm"
                    >
                        <span class="text-strux-text-faint shrink-0 tabular-nums">{{ formatTime(log.timestamp) }}</span>
                        <span class="shrink-0 w-20 truncate" :class="sourceClass(log.source)">[{{ log.source }}]</span>
                        <span class="text-strux-text-dim whitespace-pre-wrap break-all">{{ log.line }}</span>
                    </div>
                </div>
            </main>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { Badge, Button, Card, CardHeader, CardTitle, CardContent, CardAction, Spinner } from "@strux-sh/ui"
import { useDeviceStore } from "@/stores/device"

const store = useDeviceStore()
const router = useRouter()
const logEl = ref<HTMLElement | null>(null)

const connectionLabel = computed(() => {
    if (store.status !== "connected") return "Dev server offline"
    return store.deviceConnected ? "Device online" : "No device"
})
const connectionVariant = computed(() => {
    if (store.status !== "connected") return "destructive" as const
    return store.deviceConnected ? ("ok" as const) : ("warn" as const)
})

const buildBadge = computed(() =>
    store.buildState.state === "building"
        ? { variant: "warn" as const, label: store.buildState.label || "Building" }
        : { variant: "secondary" as const, label: "Idle" }
)

function sourceClass(source: string): string {
    switch (source) {
        case "app": return "text-strux-ok"
        case "cage": return "text-strux-accent-bright"
        case "client": return "text-strux-accent"
        case "screen": return "text-strux-accent-soft"
        case "journalctl":
        case "service": return "text-strux-info"
        case "early": return "text-strux-warn"
        default: return "text-strux-text-faint"
    }
}

function formatTime(ts: string): string {
    const d = new Date(ts)
    if (!Number.isNaN(d.getTime())) return d.toLocaleTimeString("en-GB", { hour12: false })
    return ts
}

function confirmReboot(): void {
    if (window.confirm("Reboot the connected device?")) store.rebootDevice()
}

// Auto-scroll the log view to the newest line.
watch(
    () => store.logs.length,
    () => {
        nextTick(() => {
            if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
        })
    }
)

onMounted(() => {
    store.init()
})
</script>
