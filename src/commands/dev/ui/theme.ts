/***
 *
 *
 * TUI Theme
 *
 *
 */


export const theme = {

    colors: {
        primary: "#a5a5ff",
        success: "green",
        error: "red",
        warning: "yellow",
        muted: "gray",
        accent: "#9d8cff",
        text: "white",
        textDim: "gray",
    },

    icons: {
        connected: "●",
        disconnected: "○",
        running: "●",
        stopped: "○",
        idle: "◌",
        error: "✗",
        arrow: "›",
        selected: "▸",
        unselected: " ",
    },

    borders: {
        top: "─",
        bottom: "─",
        left: "│",
        right: "│",
        topLeft: "┌",
        topRight: "┐",
        bottomLeft: "└",
        bottomRight: "┘",
        teeRight: "├",
        teeLeft: "┤",
        teeDown: "┬",
        teeUp: "┴",
        cross: "┼",
    },

} as const


export type ResourceStatus = "connected" | "running" | "stopped" | "idle" | "error" | "disconnected" | "paused"


export function getStatusIcon(status: ResourceStatus): string {

    switch (status) {
        case "connected": return theme.icons.connected
        case "running": return theme.icons.running
        case "stopped": return theme.icons.stopped
        case "idle": return theme.icons.idle
        case "error": return theme.icons.error
        case "disconnected": return theme.icons.disconnected
        case "paused": return theme.icons.idle
    }

}


export function getStatusColor(status: ResourceStatus): string {

    switch (status) {
        case "connected": return theme.colors.success
        case "running": return theme.colors.success
        case "stopped": return theme.colors.muted
        case "idle": return theme.colors.textDim
        case "error": return theme.colors.error
        case "disconnected": return theme.colors.warning
        case "paused": return theme.colors.warning
    }

}
