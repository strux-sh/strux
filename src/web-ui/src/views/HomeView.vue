<template>
  <div class="h-screen flex flex-col bg-void">

    <!-- ═══ Top status bar ═══ -->
    <div class="flex items-center justify-between px-4 py-2 bg-surface border-b border-line">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <span class="text-violet font-bold text-base tracking-[0.3em]">STRUX</span>
          <span class="text-text-ghost text-xs">//</span>
          <span class="text-text-dim text-xs uppercase tracking-widest">Mission Control</span>
        </div>
        <SBadge variant="success">Online</SBadge>
      </div>
      <div class="flex items-center gap-5">
        <div class="flex items-center gap-2">
          <span class="text-text-ghost text-xs">UPTIME</span>
          <span class="text-phosphor text-xs font-medium">04:32:17</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-text-ghost text-xs">NET</span>
          <SStatusDot status="connected" pulse />
          <span class="text-text-dim text-xs">192.168.1.100</span>
        </div>
        <span class="text-text-ghost text-xs">v0.3.0</span>
      </div>
    </div>

    <!-- ═══ Main layout ═══ -->
    <div class="flex-1 flex overflow-hidden">

      <!-- ─── Sidebar ─── -->
      <div class="w-60 border-r border-line bg-base flex flex-col">

        <!-- Devices -->
        <div class="border-b border-line">
          <div class="px-3 py-2 flex items-center gap-2">
            <span class="text-violet text-xs">&#x2502;</span>
            <span class="text-xs font-medium uppercase tracking-[0.2em] text-text-dim">Devices</span>
          </div>
          <div class="px-1.5 pb-2 space-y-0.5">
            <div class="flex items-center gap-2.5 px-2.5 py-2 bg-violet/10 border-l-2 border-violet text-text cursor-pointer">
              <SStatusDot status="connected" pulse />
              <div class="flex flex-col">
                <span class="text-sm font-medium">hd215-dev</span>
                <span class="text-xs text-text-ghost">rk3576 · arm64</span>
              </div>
            </div>
            <div class="flex items-center gap-2.5 px-2.5 py-2 border-l-2 border-transparent text-text-dim hover:bg-surface cursor-pointer transition-colors">
              <SStatusDot status="disconnected" />
              <div class="flex flex-col">
                <span class="text-sm">hd215-staging</span>
                <span class="text-xs text-text-ghost">rk3576 · arm64</span>
              </div>
            </div>
            <div class="flex items-center gap-2.5 px-2.5 py-2 border-l-2 border-transparent text-text-dim hover:bg-surface cursor-pointer transition-colors">
              <SStatusDot status="stopped" />
              <div class="flex flex-col">
                <span class="text-sm">rpi4-kiosk</span>
                <span class="text-xs text-text-ghost">bcm2711 · arm64</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Resources -->
        <div class="border-b border-line">
          <div class="px-3 py-2 flex items-center gap-2">
            <span class="text-violet text-xs">&#x2502;</span>
            <span class="text-xs font-medium uppercase tracking-[0.2em] text-text-dim">Resources</span>
          </div>
          <div class="px-1.5 pb-2 space-y-0.5 text-sm">
            <div class="flex items-center justify-between px-2.5 py-1.5 hover:bg-surface cursor-pointer transition-colors">
              <span class="text-text-dim">&#x251C; Logs</span>
              <SBadge variant="info">LIVE</SBadge>
            </div>
            <div class="flex items-center justify-between px-2.5 py-1.5 hover:bg-surface cursor-pointer transition-colors">
              <span class="text-text-dim">&#x251C; Terminal</span>
              <span class="text-text-ghost text-xs">SSH</span>
            </div>
            <div class="flex items-center justify-between px-2.5 py-1.5 hover:bg-surface cursor-pointer transition-colors">
              <span class="text-text-dim">&#x251C; Screen</span>
              <span class="text-text-ghost text-xs">HDMI-1</span>
            </div>
            <div class="flex items-center justify-between px-2.5 py-1.5 hover:bg-surface cursor-pointer transition-colors">
              <span class="text-text-dim">&#x2514; Files</span>
              <span class="text-text-ghost text-xs">/opt/app</span>
            </div>
          </div>
        </div>

        <!-- Shortcuts -->
        <div class="mt-auto p-3 border-t border-line">
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-text-dim text-xs">Rebuild</span>
              <div class="flex gap-1"><SKbd>Ctrl</SKbd><SKbd>B</SKbd></div>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-text-dim text-xs">Restart</span>
              <div class="flex gap-1"><SKbd>Ctrl</SKbd><SKbd>R</SKbd></div>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-text-dim text-xs">SSH</span>
              <div class="flex gap-1"><SKbd>Ctrl</SKbd><SKbd>S</SKbd></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ─── Main content area ─── -->
      <div class="flex-1 flex flex-col overflow-hidden">

        <!-- Tab bar -->
        <div class="flex items-center gap-0 border-b border-line bg-surface/50 px-2">
          <div class="flex items-center gap-2 px-4 py-2.5 border-b-2 border-violet text-violet-bright text-sm font-medium uppercase tracking-wider cursor-pointer">
            <span class="text-xs">&#x25C6;</span>
            Overview
          </div>
          <div class="flex items-center gap-2 px-4 py-2.5 text-text-ghost text-sm uppercase tracking-wider cursor-pointer hover:text-text-dim transition-colors">
            Logs
          </div>
          <div class="flex items-center gap-2 px-4 py-2.5 text-text-ghost text-sm uppercase tracking-wider cursor-pointer hover:text-text-dim transition-colors">
            Terminal
          </div>
          <div class="flex items-center gap-2 px-4 py-2.5 text-text-ghost text-sm uppercase tracking-wider cursor-pointer hover:text-text-dim transition-colors">
            Screen
          </div>
          <div class="flex items-center gap-2 px-4 py-2.5 text-text-ghost text-sm uppercase tracking-wider cursor-pointer hover:text-text-dim transition-colors">
            Config
          </div>
        </div>

        <!-- Content -->
        <div class="flex-1 overflow-auto p-4 space-y-4 stagger-children">

          <!-- Row 1: Device info + Quick actions -->
          <div class="grid grid-cols-3 gap-4">
            <SPanel title="Device // hd215-dev" class="col-span-2">
              <div class="grid grid-cols-4 gap-4">
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-1">Status</span>
                  <div class="flex items-center gap-1.5">
                    <SStatusDot status="connected" pulse />
                    <span class="text-phosphor text-sm font-medium">ONLINE</span>
                  </div>
                </div>
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-1">Platform</span>
                  <span class="text-text text-sm">rk3576 / arm64</span>
                </div>
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-1">Memory</span>
                  <span class="text-text text-sm">412M <span class="text-text-ghost">/</span> 2048M</span>
                </div>
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-1">Client</span>
                  <SBadge variant="info">v0.3.0</SBadge>
                </div>
              </div>
            </SPanel>

            <SPanel title="Quick Actions">
              <div class="space-y-2">
                <SButton class="w-full">Rebuild &amp; Deploy</SButton>
                <SButton variant="secondary" class="w-full">Restart Service</SButton>
                <SButton variant="danger" class="w-full">Reboot Device</SButton>
              </div>
            </SPanel>
          </div>

          <!-- Row 2: Log preview + Build status -->
          <div class="grid grid-cols-3 gap-4">
            <SPanel title="Recent Logs" class="col-span-2" no-padding>
              <div class="font-mono text-sm leading-relaxed p-3 space-y-1">
                <div class="flex">
                  <span class="text-text-dim w-22 shrink-0">12:04:32</span>
                  <span class="text-cyan mr-2">[sys]</span>
                  <span class="text-text">wpe-webkit: page loaded in 1.2s</span>
                </div>
                <div class="flex">
                  <span class="text-text-dim w-22 shrink-0">12:04:31</span>
                  <span class="text-phosphor mr-2">[app]</span>
                  <span class="text-text">server listening on :8080</span>
                </div>
                <div class="flex">
                  <span class="text-text-dim w-22 shrink-0">12:04:30</span>
                  <span class="text-violet-bright mr-2">[strux]</span>
                  <span class="text-text">client connected, version v0.3.0</span>
                </div>
                <div class="flex">
                  <span class="text-text-dim w-22 shrink-0">12:04:28</span>
                  <span class="text-amber mr-2">[cage]</span>
                  <span class="text-text">compositor started on HDMI-A-1</span>
                </div>
                <div class="flex">
                  <span class="text-text-dim w-22 shrink-0">12:04:25</span>
                  <span class="text-cyan mr-2">[sys]</span>
                  <span class="text-text">network interface wlan0 up, 192.168.1.100</span>
                </div>
                <div class="flex opacity-60">
                  <span class="text-text-dim w-22 shrink-0">12:04:20</span>
                  <span class="text-text-dim mr-2">[boot]</span>
                  <span class="text-text-dim">kernel 6.1.75-strux booted in 3.8s</span>
                </div>
              </div>
            </SPanel>

            <SPanel title="Build Status">
              <div class="space-y-3">
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-text-dim text-xs uppercase tracking-widest">Frontend</span>
                    <SBadge variant="success">Cached</SBadge>
                  </div>
                  <div class="h-1.5 bg-surface">
                    <div class="h-full w-full bg-phosphor/40" />
                  </div>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-text-dim text-xs uppercase tracking-widest">Application</span>
                    <SBadge variant="success">Cached</SBadge>
                  </div>
                  <div class="h-1.5 bg-surface">
                    <div class="h-full w-full bg-phosphor/40" />
                  </div>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-text-dim text-xs uppercase tracking-widest">Client</span>
                    <SBadge variant="warning">Building</SBadge>
                  </div>
                  <div class="h-1.5 bg-surface">
                    <div class="h-full w-3/4 bg-amber/40" />
                  </div>
                </div>
                <div>
                  <div class="flex items-center justify-between mb-1.5">
                    <span class="text-text-dim text-xs uppercase tracking-widest">Rootfs</span>
                    <SBadge>Pending</SBadge>
                  </div>
                  <div class="h-1.5 bg-surface">
                    <div class="h-full w-0 bg-text-ghost/40" />
                  </div>
                </div>
              </div>
            </SPanel>
          </div>

          <!-- Row 3: Controls demo -->
          <div class="grid grid-cols-3 gap-4">
            <SPanel title="Controls">
              <div class="space-y-4">
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-2">Command</span>
                  <div class="flex gap-2">
                    <SInput placeholder="systemctl restart strux-app" v-model="cmdInput" />
                    <SButton>Exec</SButton>
                  </div>
                </div>
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-2">Log Source</span>
                  <SSelect v-model="logSource">
                    <option value="all">All Sources</option>
                    <option value="app">Application</option>
                    <option value="sys">System</option>
                    <option value="kernel">Kernel</option>
                  </SSelect>
                </div>
              </div>
            </SPanel>

            <SPanel title="Preferences">
              <div class="space-y-3">
                <SToggle v-model="autoRestart" label="Auto-restart on crash" />
                <SToggle v-model="verboseLogs" label="Verbose logging" />
                <SToggle v-model="autoSync" label="Auto-sync file changes" />
                <SToggle label="Remote screen capture" />
              </div>
            </SPanel>

            <SPanel title="Component Matrix">
              <div class="space-y-3">
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-2">Buttons</span>
                  <div class="flex gap-1.5 flex-wrap">
                    <SButton size="sm">Primary</SButton>
                    <SButton variant="secondary" size="sm">Secondary</SButton>
                    <SButton variant="ghost" size="sm">Ghost</SButton>
                    <SButton variant="danger" size="sm">Danger</SButton>
                    <SButton size="sm" disabled>Disabled</SButton>
                  </div>
                </div>
                <div>
                  <span class="text-text-dim text-xs uppercase tracking-widest block mb-2">Badges</span>
                  <div class="flex gap-1.5 flex-wrap">
                    <SBadge>Default</SBadge>
                    <SBadge variant="success">OK</SBadge>
                    <SBadge variant="warning">Warn</SBadge>
                    <SBadge variant="error">Fail</SBadge>
                    <SBadge variant="info">Info</SBadge>
                  </div>
                </div>
              </div>
            </SPanel>
          </div>

        </div>
      </div>
    </div>

    <!-- ═══ Bottom bar ═══ -->
    <div class="flex items-center justify-between px-4 py-1.5 bg-surface border-t border-line text-xs">
      <div class="flex items-center gap-4 text-text-dim">
        <span>&#x250C; strux dev</span>
        <span>&#x2502; hd215-dev</span>
        <span>&#x2502; ws://localhost:8000</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-text-dim">CPU <span class="text-cyan">12%</span></span>
        <span class="text-text-dim">MEM <span class="text-cyan">412M</span></span>
        <span class="text-text-dim">NET <span class="text-phosphor">&#x25B2;</span><span class="text-text">2.1k</span> <span class="text-cyan">&#x25BC;</span><span class="text-text">840</span></span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { SButton, SInput, SBadge, SPanel, SSelect, SToggle, SStatusDot, SKbd } from '@/components/ui'

const cmdInput = ref('')
const logSource = ref('all')
const autoRestart = ref(true)
const verboseLogs = ref(false)
const autoSync = ref(true)
</script>
