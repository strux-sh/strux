<template>
  <span :class="['inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-medium uppercase tracking-widest border', badgeClasses]">
    <span :class="['inline-block w-1.5 h-1.5', dotClasses]" />
    <slot />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info'
}>()

const badgeClasses = computed(() => {
  switch (props.variant) {
    case 'success': return 'bg-phosphor/8 border-phosphor/30 text-phosphor'
    case 'warning': return 'bg-amber/8 border-amber/30 text-amber'
    case 'error': return 'bg-alarm/8 border-alarm/30 text-alarm'
    case 'info': return 'bg-cyan/8 border-cyan/30 text-cyan'
    default: return 'bg-surface border-line text-text-dim'
  }
})

const dotClasses = computed(() => {
  switch (props.variant) {
    case 'success': return 'bg-phosphor'
    case 'warning': return 'bg-amber'
    case 'error': return 'bg-alarm'
    case 'info': return 'bg-cyan'
    default: return 'bg-text-ghost'
  }
})
</script>
