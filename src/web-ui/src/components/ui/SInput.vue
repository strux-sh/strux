<template>
  <div class="relative group">
    <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-ghost text-xs font-mono group-focus-within:text-violet transition-colors">&#x25B8;</span>
    <input
      :type="type ?? 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="w-full pl-7 pr-3 py-2 text-xs font-mono bg-base border border-line text-text placeholder:text-text-ghost focus:outline-none focus:border-violet focus:shadow-[0_0_12px_rgba(139,92,246,0.15)] disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-150"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  type?: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>
