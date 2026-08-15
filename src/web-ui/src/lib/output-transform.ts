import type { OutputTransform } from "@/lib/protocol"

const transforms = new Set<OutputTransform>([
    "normal",
    "90",
    "180",
    "270",
    "flipped",
    "flipped-90",
    "flipped-180",
    "flipped-270",
])

export function normalizeOutputTransform(value?: string): OutputTransform {
    return transforms.has(value as OutputTransform)
        ? value as OutputTransform
        : "normal"
}

export function isQuarterTurn(transform: OutputTransform): boolean {
    return transform === "90" || transform === "270" ||
        transform === "flipped-90" || transform === "flipped-270"
}

export function transformedSize(width: number, height: number, transform: OutputTransform): { width: number; height: number } {
    return isQuarterTurn(transform)
        ? { width: height, height: width }
        : { width, height }
}

/**
 * Paint a raw screencopy buffer in the logical, upright output orientation.
 * Wayland output transforms describe the scanout transformation, so the
 * viewer applies its inverse. Reflection transforms are self-inverse.
 */
export function drawTransformed(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    transform: OutputTransform
): void {
    switch (transform) {
        case "90":
            context.setTransform(0, -1, 1, 0, 0, sourceWidth)
            break
        case "180":
            context.setTransform(-1, 0, 0, -1, sourceWidth, sourceHeight)
            break
        case "270":
            context.setTransform(0, 1, -1, 0, sourceHeight, 0)
            break
        case "flipped":
            context.setTransform(-1, 0, 0, 1, sourceWidth, 0)
            break
        case "flipped-90":
            context.setTransform(0, 1, 1, 0, 0, 0)
            break
        case "flipped-180":
            context.setTransform(1, 0, 0, -1, 0, sourceHeight)
            break
        case "flipped-270":
            context.setTransform(0, -1, -1, 0, sourceHeight, sourceWidth)
            break
        default:
            context.setTransform(1, 0, 0, 1, 0, 0)
    }

    context.drawImage(source, 0, 0)
    context.resetTransform()
}

export function inverseCssTransform(transform: OutputTransform): string {
    switch (transform) {
        case "90": return "rotate(-90deg)"
        case "180": return "rotate(180deg)"
        case "270": return "rotate(90deg)"
        case "flipped": return "scaleX(-1)"
        case "flipped-90": return "rotate(-90deg) scaleX(-1)"
        case "flipped-180": return "rotate(180deg) scaleX(-1)"
        case "flipped-270": return "rotate(90deg) scaleX(-1)"
        default: return "none"
    }
}
