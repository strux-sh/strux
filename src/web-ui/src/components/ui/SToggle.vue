<template>
  <label class="inline-flex items-center gap-2.5 cursor-pointer select-none" :class="disabled && 'opacity-30 cursor-not-allowed'">
    <button
      type="button"
      role="switch"
      :aria-checked="modelValue"
      :disabled="disabled"
      :class="[
        'relative w-9 h-[18px] border transition-all duration-200',
        modelValue
          ? 'bg-violet/15 border-violet shadow-[0_0_10px_rgba(139,92,246,0.2)]'
          : 'bg-surface border-line',
      ]"
      @click="!disabled && $emit('update:modelValue', !modelValue)"
    >
      <span
        :class="[
          'absolute top-[3px] w-2.5 h-2.5 transition-all duration-200',
          modelValue
            ? 'left-[19px] bg-violet-bright shadow-[0_0_6px_rgba(196,181,253,0.5)]'
            : 'left-[3px] bg-text-ghost',
        ]"
      />
    </button>
    <span v-if="label" class="text-sm text-text-dim">{{ label }}</span>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  modelValue?: boolean
  label?: string
  disabled?: boolean
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>
