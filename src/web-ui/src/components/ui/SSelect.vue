<template>
  <div class="relative group">
    <select
      :value="modelValue"
      :disabled="disabled"
      class="w-full px-3 py-2 text-xs font-mono appearance-none bg-base border border-line text-text focus:outline-none focus:border-violet focus:shadow-[0_0_12px_rgba(139,92,246,0.15)] disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <slot />
    </select>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue?: string
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>
