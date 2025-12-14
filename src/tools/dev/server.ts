/***
 *
 *  Dev Server - HTTP server that proxies to Vite
 *
 */

import { serve } from "bun"

const VITE_PORT = 5173
const DEV_SERVER_PORT = 3000

// Map to store WebSocket connections to Vite for each client
const viteConnections = new Map<WebSocket, WebSocket>()
// Track if server is shutting down to suppress expected errors
let isShuttingDown = false

/**
 * Start the dev server that proxies frontend requests to Vite
 */
export async function startDevServer(): Promise<() => void> {
    const server = serve({
        port: DEV_SERVER_PORT,
        async fetch(req, server) {
            const url = new URL(req.url)

            // Health check endpoint
            if (url.pathname === "/api/health") {
                return new Response(JSON.stringify({ status: "ok" }), {
                    headers: { "Content-Type": "application/json" },
                })
            }

            // Binary info endpoint
            if (url.pathname === "/api/binary") {
                const { stat } = await import("fs/promises")
                const { join } = await import("path")
                const cwd = process.cwd()
                const binaryPath = join(cwd, "dist", "strux", "app")

                try {
                    const stats = await stat(binaryPath)
                    return new Response(
                        JSON.stringify({
                            path: binaryPath,
                            size: stats.size,
                            mtime: stats.mtime.toISOString(),
                        }),
                        {
                            headers: { "Content-Type": "application/json" },
                        }
                    )
                } catch {
                    return new Response(
                        JSON.stringify({ error: "Binary not found" }),
                        {
                            status: 404,
                            headers: { "Content-Type": "application/json" },
                        }
                    )
                }
            }

            // Handle WebSocket upgrade requests (Vite HMR)
            if (req.headers.get("upgrade") === "websocket") {
                // Upgrade client connection and pass URL data
                if (server.upgrade(req, {
                    data: {
                        pathname: url.pathname,
                        search: url.search,
                    },
                })) {
                    // The websocket handlers below will handle the proxying
                    return // Upgrade handled
                }
                
                return new Response("WebSocket upgrade failed", { status: 500 })
            }

            // Proxy all other requests to Vite dev server
            const viteUrl = `http://localhost:${VITE_PORT}${url.pathname}${url.search}`

            try {
                const viteResponse = await fetch(viteUrl, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body,
                })

                // Create a new response with the same status and headers
                const response = new Response(viteResponse.body, {
                    status: viteResponse.status,
                    statusText: viteResponse.statusText,
                    headers: viteResponse.headers,
                })

                return response
            } catch (error) {
                return new Response(
                    `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
                    { status: 502 }
                )
            }
        },
        websocket: {
            async open(ws) {
                // When client WebSocket opens, create connection to Vite
                const data = ws.data as { pathname: string; search: string } | undefined
                const pathname = data?.pathname || "/"
                const search = data?.search || ""
                const viteWsUrl = `ws://localhost:${VITE_PORT}${pathname}${search}`
                
                try {
                    const viteWs = new WebSocket(viteWsUrl)
                    
                    // Store the mapping
                    viteConnections.set(ws, viteWs)
                    
                    // Forward messages from Vite to client
                    viteWs.addEventListener("message", (event) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(event.data)
                        }
                    })
                    
                    viteWs.addEventListener("error", (error) => {
                        // Only log errors if not shutting down (expected during cleanup)
                        if (!isShuttingDown) {
                            console.error("Vite WebSocket error:", error)
                        }
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close()
                        }
                    })
                    
                    viteWs.addEventListener("close", () => {
                        viteConnections.delete(ws)
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close()
                        }
                    })
                } catch (error) {
                    // Only log errors if not shutting down
                    if (!isShuttingDown) {
                        console.error("Failed to connect to Vite WebSocket:", error)
                    }
                    ws.close()
                }
            },
            async message(ws, message) {
                // Forward messages from client to Vite
                const viteWs = viteConnections.get(ws)
                if (viteWs && viteWs.readyState === WebSocket.OPEN) {
                    viteWs.send(message)
                }
            },
            async close(ws) {
                // Clean up Vite connection
                const viteWs = viteConnections.get(ws)
                if (viteWs) {
                    viteConnections.delete(ws)
                    if (viteWs.readyState === WebSocket.OPEN) {
                        viteWs.close()
                    }
                }
            },
        },
    })

    console.log(`Dev server running on http://localhost:${DEV_SERVER_PORT}`)
    console.log(`Proxying to Vite on http://localhost:${VITE_PORT}`)
    console.log(`WebSocket proxying enabled for Vite HMR`)

    return () => {
        // Mark as shutting down to suppress expected errors
        isShuttingDown = true
        
        // Close all Vite connections gracefully
        for (const viteWs of viteConnections.values()) {
            try {
                if (viteWs.readyState === WebSocket.OPEN || viteWs.readyState === WebSocket.CONNECTING) {
                    viteWs.close()
                }
            } catch {
                // Ignore errors during cleanup
            }
        }
        viteConnections.clear()
        server.stop()
    }
}

