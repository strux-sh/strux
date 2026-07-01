/**
 * DOM KeyboardEvent.code -> Linux evdev keycode (input-event-codes.h).
 *
 * Starter map covering the main typing area, arrows, nav cluster and F-keys.
 * Extend as needed. evdev keycode = xkb keycode - 8 (Cage adds 8 back).
 */
export const CODE_TO_EVDEV: Record<string, number> = {
    Escape: 1,
    Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
    Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
    Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
    KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21,
    KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27,
    Enter: 28, ControlLeft: 29,
    KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35,
    KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
    ShiftLeft: 42, Backslash: 43,
    KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
    Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
    AltLeft: 56, Space: 57, CapsLock: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
    F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
    ControlRight: 97, AltRight: 100,
    Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
    End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
    MetaLeft: 125, MetaRight: 126,
}

// xkb modifier-mask bits (default keymap) for the virtual-keyboard modifiers event.
const MOD_SHIFT = 1 << 0
const MOD_CAPS = 1 << 1
const MOD_CTRL = 1 << 2
const MOD_ALT = 1 << 3
const MOD_LOGO = 1 << 6

export function modifierMask(e: KeyboardEvent): number {
    let mask = 0
    if (e.shiftKey) mask |= MOD_SHIFT
    if (e.getModifierState?.("CapsLock")) mask |= MOD_CAPS
    if (e.ctrlKey) mask |= MOD_CTRL
    if (e.altKey) mask |= MOD_ALT
    if (e.metaKey) mask |= MOD_LOGO
    return mask
}

export function evdevKeycode(code: string): number | undefined {
    return CODE_TO_EVDEV[code]
}
