<template>
  <button
    :disabled="disabled"
    :class="[
      'inline-flex items-center justify-center font-mono font-medium tracking-wide uppercase cursor-pointer',
      'border transition-all duration-150',
      'focus:outline-none',
      'disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none',
      sizeClasses,
      variantClasses,
    ]"
  >
    <span v-if="variant === 'primary' || !variant" class="mr-1.5 text-xs opacity-60">&#x25B8;</span>
    <slot />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
}>()

const sizeClasses = computed(() => {
  switch (props.size) {
    case 'sm': return 'px-3 py-1 text-xs'
    case 'lg': return 'px-6 py-3 text-sm'
    default: return 'px-4 py-2 text-xs'
  }
})

const variantClasses = computed(() => {
  switch (props.variant) {
    case 'secondary':
      return 'bg-surface border-line text-text hover:border-line-bright hover:bg-elevated hover:text-violet-bright'
    case 'ghost':
      return 'bg-transparent border-transparent text-text-dim hover:text-text hover:bg-surface'
    case 'danger':
      return 'bg-alarm/5 border-alarm/30 text-alarm hover:bg-alarm/10 hover:border-alarm/60 hover:shadow-[0_0_12px_rgba(255,85,85,0.15)]'
    default:
      return 'bg-violet/10 border-violet text-violet-bright hover:bg-violet/20 hover:shadow-[0_0_16px_rgba(139,92,246,0.25)]'
  }
})
</script>
