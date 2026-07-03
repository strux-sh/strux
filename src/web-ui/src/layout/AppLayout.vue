<template>
    <div class="h-screen flex flex-col bg-strux-bg font-strux-sans">


        <header class="flex items-center justify-between px-4 py-2 bg-strux-surface border-b border-strux-divider">
            <div class="flex items-center gap-3 font-strux-mono">
                <img src="@/assets/strux-white.svg" alt="Strux Logo" class="h-7"/>
                <div class="mt-0.5">
                    <span class="text-strux-text-faint text-xs">// </span>
                    <span class="text-strux-text-dim text-strux-label uppercase tracking-strux-label">{{ title }}</span>
                </div>

            </div>
            <div class="flex items-center gap-3">
                <slot name="header-right" />
            </div>
        </header>

        <div class="flex-1 flex overflow-hidden">
            <slot name="content" />
        </div>


    </div>


</template>

<script setup lang="ts">

const props = defineProps<{
    title: string
}>()

</script>

<style scoped lang="scss">

</style>