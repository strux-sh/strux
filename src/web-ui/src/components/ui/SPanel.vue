<template>
  <div class="corner-marks bg-base border border-line flex flex-col overflow-hidden">
    <div v-if="title" class="flex items-center justify-between px-3 py-2 border-b border-line bg-surface/50">
      <div class="flex items-center gap-2">
        <span class="text-violet text-xs">&#x2502;</span>
        <span class="text-xs font-mono font-medium uppercase tracking-[0.2em] text-text-dim">{{ title }}</span>
      </div>
      <slot name="actions" />
    </div>
    <div :class="noPadding ? '' : 'p-3'" class="flex-1 overflow-auto">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string
  noPadding?: boolean
}>()
</script>
