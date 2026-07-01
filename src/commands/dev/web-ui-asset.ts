/**
 * Web-UI embed.
 *
 * Static text import of the built single-file dev tool. In the compiled binary
 * this embeds dist/index.html at build time (the root `build` script runs
 * `build:web-ui` first). Imported dynamically from index.ts so a dev-from-source
 * checkout without a built dist degrades gracefully instead of failing to load.
 */
import webUiHtml from "../../web-ui/dist/index.html" with { type: "text" }

export default webUiHtml
