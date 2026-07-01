/**
 * useInputCapture — translate DOM pointer/keyboard events over a streamed
 * <video> into normalized input messages and push them to the dev server.
 *
 * Pointer coordinates are normalized 0..1 within the video's content box, so
 * the device-side virtual pointer maps them onto the named output. Inert until
 * the Phase 2 device injector consumes them; safe to run now.
 */
import { onBeforeUnmount, watch, type Ref } from "vue"
import { evdevButton, type DevtoolOutbound } from "@/lib/protocol"
import { evdevKeycode, modifierMask } from "@/lib/keymap"

interface InputCaptureOptions {
  target: Ref<HTMLElement | null>
  outputName: () => string
  enabled: Ref<boolean>
  send: (msg: DevtoolOutbound) => void
}

export function useInputCapture(opts: InputCaptureOptions): void {
    const { target, outputName, enabled, send } = opts

    let lastModifiers = -1
    let motionQueued = false
    let pendingXY: { x: number; y: number } | null = null

    function normalized(e: MouseEvent, el: HTMLElement): { x: number; y: number } | null {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const x = (e.clientX - rect.left) / rect.width
        const y = (e.clientY - rect.top) / rect.height
        if (x < 0 || x > 1 || y < 0 || y > 1) return null
        return { x, y }
    }

    function onPointerMove(e: MouseEvent): void {
        const el = target.value
        if (!el) return
        const pos = normalized(e, el)
        if (!pos) return
        pendingXY = pos
        if (motionQueued) return
        motionQueued = true
        requestAnimationFrame(() => {
            motionQueued = false
            if (!pendingXY) return
            send({ type: "input-pointer-motion", payload: { outputName: outputName(), x: pendingXY.x, y: pendingXY.y } })
        })
    }

    function onPointerDown(e: MouseEvent): void {
        target.value?.focus()
        send({ type: "input-pointer-button", payload: { outputName: outputName(), button: evdevButton(e.button), pressed: true } })
        e.preventDefault()
    }

    function onPointerUp(e: MouseEvent): void {
        send({ type: "input-pointer-button", payload: { outputName: outputName(), button: evdevButton(e.button), pressed: false } })
        e.preventDefault()
    }

    function onWheel(e: WheelEvent): void {
        const axis = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? "horizontal" : "vertical"
        const value = axis === "horizontal" ? e.deltaX : e.deltaY
        send({ type: "input-pointer-axis", payload: { outputName: outputName(), axis, value } })
        e.preventDefault()
    }

    function syncModifiers(e: KeyboardEvent): void {
        const mask = modifierMask(e)
        if (mask === lastModifiers) return
        lastModifiers = mask
        send({ type: "input-keyboard-modifiers", payload: { outputName: outputName(), depressed: mask, latched: 0, locked: 0, group: 0 } })
    }

    function onKeyDown(e: KeyboardEvent): void {
        const keycode = evdevKeycode(e.code)
        if (keycode === undefined) return
        syncModifiers(e)
        send({ type: "input-keyboard-key", payload: { outputName: outputName(), keycode, pressed: true } })
        e.preventDefault()
    }

    function onKeyUp(e: KeyboardEvent): void {
        const keycode = evdevKeycode(e.code)
        if (keycode === undefined) return
        send({ type: "input-keyboard-key", payload: { outputName: outputName(), keycode, pressed: false } })
        syncModifiers(e)
        e.preventDefault()
    }

    function bind(el: HTMLElement): void {
        el.addEventListener("mousemove", onPointerMove)
        el.addEventListener("mousedown", onPointerDown)
        el.addEventListener("mouseup", onPointerUp)
        el.addEventListener("wheel", onWheel, { passive: false })
        el.addEventListener("keydown", onKeyDown)
        el.addEventListener("keyup", onKeyUp)
        el.addEventListener("contextmenu", preventContext)
    }

    function unbind(el: HTMLElement): void {
        el.removeEventListener("mousemove", onPointerMove)
        el.removeEventListener("mousedown", onPointerDown)
        el.removeEventListener("mouseup", onPointerUp)
        el.removeEventListener("wheel", onWheel)
        el.removeEventListener("keydown", onKeyDown)
        el.removeEventListener("keyup", onKeyUp)
        el.removeEventListener("contextmenu", preventContext)
    }

    function preventContext(e: Event): void {
        e.preventDefault()
    }

    // Bind/unbind as the target element or the enabled flag changes.
    watch(
        [target, enabled],
        ([el], _prev, onCleanup) => {
            if (el && enabled.value) {
                bind(el)
                onCleanup(() => unbind(el))
            }
        },
        { immediate: true }
    )

    onBeforeUnmount(() => {
        if (target.value) unbind(target.value)
    })
}
