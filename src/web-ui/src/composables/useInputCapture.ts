/**
 * useInputCapture — translate DOM pointer/keyboard events over a streamed
 * <video> into normalized input messages and push them to the dev server.
 *
 * Uses Pointer Events with setPointerCapture so drags keep flowing even when
 * the pointer leaves the video mid-gesture; coordinates are clamped to the
 * content box while a button is held, and buttons are force-released on
 * pointercancel so the device is never left with a stuck button.
 *
 * Exposes `pointerPos` (video-relative pixels, clamped) so the view can render
 * a local virtual cursor that always matches what is sent to the device.
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue"
import { evdevButton, type DevtoolOutbound } from "@/lib/protocol"
import { evdevKeycode, modifierMask } from "@/lib/keymap"

interface InputCaptureOptions {
  target: Ref<HTMLElement | null>
  outputName: () => string
  enabled: Ref<boolean>
  send: (msg: DevtoolOutbound) => void
}

export function useInputCapture(opts: InputCaptureOptions) {
    const { target, outputName, enabled, send } = opts

    const pointerPos = ref<{ x: number; y: number } | null>(null)

    let lastModifiers = -1
    let motionQueued = false
    let pendingXY: { x: number; y: number } | null = null
    const pressedButtons = new Set<number>()

    function clampedPoint(e: PointerEvent | MouseEvent, el: HTMLElement): { x: number; y: number; nx: number; ny: number } | null {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return null
        const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width)
        const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height)
        return { x, y, nx: x / rect.width, ny: y / rect.height }
    }

    function onPointerMove(e: PointerEvent): void {
        const el = target.value
        if (!el) return
        const pos = clampedPoint(e, el)
        if (!pos) return
        pointerPos.value = { x: pos.x, y: pos.y }
        pendingXY = { x: pos.nx, y: pos.ny }
        if (motionQueued) return
        motionQueued = true
        requestAnimationFrame(() => {
            motionQueued = false
            if (!pendingXY) return
            send({ type: "input-pointer-motion", payload: { outputName: outputName(), x: pendingXY.x, y: pendingXY.y } })
        })
    }

    function onPointerDown(e: PointerEvent): void {
        const el = target.value
        if (!el) return
        el.focus()
        // Keep receiving move/up events for the whole drag, even outside the video
        try {
            el.setPointerCapture(e.pointerId)
        } catch {
            /* capture unavailable for this pointer — degrade to plain events */
        }
        const button = evdevButton(e.button)
        pressedButtons.add(button)
        send({ type: "input-pointer-button", payload: { outputName: outputName(), button, pressed: true } })
        e.preventDefault()
    }

    function onPointerUp(e: PointerEvent): void {
        const button = evdevButton(e.button)
        pressedButtons.delete(button)
        send({ type: "input-pointer-button", payload: { outputName: outputName(), button, pressed: false } })
        e.preventDefault()
    }

    // Gesture aborted (e.g. by the browser) — release anything still held so
    // the device never keeps a phantom pressed button.
    function onPointerCancel(_e: PointerEvent): void {
        for (const button of pressedButtons) {
            send({ type: "input-pointer-button", payload: { outputName: outputName(), button, pressed: false } })
        }
        pressedButtons.clear()
    }

    function onPointerLeave(_e: PointerEvent): void {
        // Hide the virtual cursor when hovering away (captured drags still
        // deliver moves, which re-show it immediately)
        if (pressedButtons.size === 0) pointerPos.value = null
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

    function preventDefault(e: Event): void {
        e.preventDefault()
    }

    function bind(el: HTMLElement): void {
        el.addEventListener("pointermove", onPointerMove)
        el.addEventListener("pointerdown", onPointerDown)
        el.addEventListener("pointerup", onPointerUp)
        el.addEventListener("pointercancel", onPointerCancel)
        el.addEventListener("pointerleave", onPointerLeave)
        el.addEventListener("wheel", onWheel, { passive: false })
        el.addEventListener("keydown", onKeyDown)
        el.addEventListener("keyup", onKeyUp)
        el.addEventListener("contextmenu", preventDefault)
        el.addEventListener("dragstart", preventDefault)
    }

    function unbind(el: HTMLElement): void {
        el.removeEventListener("pointermove", onPointerMove)
        el.removeEventListener("pointerdown", onPointerDown)
        el.removeEventListener("pointerup", onPointerUp)
        el.removeEventListener("pointercancel", onPointerCancel)
        el.removeEventListener("pointerleave", onPointerLeave)
        el.removeEventListener("wheel", onWheel)
        el.removeEventListener("keydown", onKeyDown)
        el.removeEventListener("keyup", onKeyUp)
        el.removeEventListener("contextmenu", preventDefault)
        el.removeEventListener("dragstart", preventDefault)
        pressedButtons.clear()
        pointerPos.value = null
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

    return { pointerPos }
}
