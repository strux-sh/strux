<template>
  <span class="relative inline-flex items-center justify-center w-3 h-3">
    <span
      v-if="pulse && (status === 'connected' || status === 'running')"
      :class="[
        'absolute inset-0 animate-ping opacity-40',
        statusColor,
      ]"
    />
    <span
      :class="[
        'relative inline-block w-[6px] h-[6px]',
        statusColor,
      ]"
    />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: 'connected' | 'running' | 'stopped' | 'idle' | 'error' | 'disconnected'
  pulse?: boolean
}>()

const statusColor = computed(() => {
  switch (props.status) {
    case 'connected':
    case 'running':
      return 'bg-phosphor'
    case 'error':
      return 'bg-alarm'
    case 'disconnected':
      return 'bg-amber'
    default:
      return 'bg-text-ghost'
  }
})
</script>
