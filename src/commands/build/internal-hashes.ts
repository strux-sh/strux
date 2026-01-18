/***
 *
 *
 *  Internal Asset Hash Computation
 *
 *  Computes hashes for bundled/embedded assets that are part of the
 *  Strux CLI itself. These are used to detect when the CLI's internal
 *  assets have changed (requiring cache invalidation).
 *
 */

// Build Scripts
// @ts-ignore
import scriptBuildFrontend from "../../assets/scripts-base/strux-build-frontend.sh" with { type: "text" }
// @ts-ignore
import scriptBuildApp from "../../assets/scripts-base/strux-build-app.sh" with { type: "text" }
// @ts-ignore
import scriptBuildCage from "../../assets/scripts-base/strux-build-cage.sh" with { type: "text" }
// @ts-ignore
import scriptBuildWPE from "../../assets/scripts-base/strux-build-wpe.sh" with { type: "text" }
// @ts-ignore
import scriptBuildBase from "../../assets/scripts-base/strux-build-base.sh" with { type: "text" }
// @ts-ignore
import scriptBuildPost from "../../assets/scripts-base/strux-build-post.sh" with { type: "text" }
// @ts-ignore
import scriptBuildClient from "../../assets/scripts-base/strux-build-client.sh" with { type: "text" }

// Go Client-base files
// @ts-ignore
import clientGoMain from "../../assets/client-base/main.go" with { type: "text" }
// @ts-ignore
import clientGoBinary from "../../assets/client-base/binary.go" with { type: "text" }
// @ts-ignore
import clientGoCage from "../../assets/client-base/cage.go" with { type: "text" }
// @ts-ignore
import clientGoConfig from "../../assets/client-base/config.go" with { type: "text" }
// @ts-ignore
import clientGoHosts from "../../assets/client-base/hosts.go" with { type: "text" }
// @ts-ignore
import clientGoLogger from "../../assets/client-base/logger.go" with { type: "text" }
// @ts-ignore
import clientGoLogs from "../../assets/client-base/logs.go" with { type: "text" }
// @ts-ignore
import clientGoSocket from "../../assets/client-base/socket.go" with { type: "text" }
// @ts-ignore
import clientGoHelpers from "../../assets/client-base/helpers.go" with { type: "text" }
// @ts-ignore
import clientGoMod from "../../assets/client-base/go.mod" with { type: "text" }
// @ts-ignore
import clientGoSum from "../../assets/client-base/go.sum" with { type: "text" }

// Plymouth Files
// @ts-ignore
import artifactPlymouthTheme from "../../assets/scripts-base/artifacts/plymouth/strux.plymouth" with { type: "text" }
// @ts-ignore
import artifactPlymouthScript from "../../assets/scripts-base/artifacts/plymouth/strux.script" with { type: "text" }
// @ts-ignore
import artifactPlymouthConf from "../../assets/scripts-base/artifacts/plymouth/plymouthd.conf" with { type: "text" }

// Init Services
// @ts-ignore
import initScript from "../../assets/scripts-base/artifacts/scripts/init.sh" with { type: "text" }
// @ts-ignore
import initNetworkScript from "../../assets/scripts-base/artifacts/scripts/strux-network.sh" with { type: "text" }
// @ts-ignore
import initStruxScript from "../../assets/scripts-base/artifacts/scripts/strux.sh" with { type: "text" }

// Systemd Services
// @ts-ignore
import systemdStruxService from "../../assets/scripts-base/artifacts/systemd/strux.service" with { type: "text" }
// @ts-ignore
import systemdNetworkService from "../../assets/scripts-base/artifacts/systemd/strux-network.service" with { type: "text" }
// @ts-ignore
import systemdEthernetNetwork from "../../assets/scripts-base/artifacts/systemd/20-ethernet.network" with { type: "text" }

// Cage sources (if bundled - we'll hash the build script as proxy)
// WPE extension sources (we'll hash the build script as proxy)

// Dockerfile
// @ts-ignore
import scriptsBaseDockerfile from "../../assets/scripts-base/Dockerfile" with { type: "text" }

/**
 * Computes a hash from multiple strings
 */
function hashStrings(...strings: string[]): string {
    return Bun.hash(strings.join("\n")).toString(16)
}

/**
 * Internal asset hashes - computed once and cached
 */
let cachedHashes: Record<string, string> | null = null

/**
 * Computes hashes for all internal (bundled) assets.
 * These are used to detect when the CLI's embedded assets have changed.
 */
export function computeInternalAssetHashes(): Record<string, string> {
    if (cachedHashes) return cachedHashes

    cachedHashes = {
        // Build scripts
        "@build-frontend-script": hashStrings(scriptBuildFrontend),
        "@build-app-script": hashStrings(scriptBuildApp),
        "@build-cage-script": hashStrings(scriptBuildCage),
        "@build-wpe-script": hashStrings(scriptBuildWPE),
        "@build-base-script": hashStrings(scriptBuildBase),
        "@build-post-script": hashStrings(scriptBuildPost),
        "@build-client-script": hashStrings(scriptBuildClient),

        // Client base (Go sources)
        "@client-base": hashStrings(
            clientGoMain,
            clientGoBinary,
            clientGoCage,
            clientGoConfig,
            clientGoHosts,
            clientGoLogger,
            clientGoLogs,
            clientGoSocket,
            clientGoHelpers,
            clientGoMod,
            clientGoSum
        ),

        // Cage sources - use build script as proxy (cage sources are in dist/cage/)
        "@cage-sources": hashStrings(scriptBuildCage),

        // WPE extension sources - use build script as proxy
        "@wpe-extension-sources": hashStrings(scriptBuildWPE),

        // Plymouth theme assets
        "@plymouth-assets": hashStrings(
            artifactPlymouthTheme,
            artifactPlymouthScript,
            artifactPlymouthConf
        ),

        // Init scripts
        "@init-scripts": hashStrings(
            initScript,
            initNetworkScript,
            initStruxScript
        ),

        // Systemd service files
        "@systemd-assets": hashStrings(
            systemdStruxService,
            systemdNetworkService,
            systemdEthernetNetwork
        ),

        // Dockerfile
        "@dockerfile": hashStrings(scriptsBaseDockerfile)
    }

    return cachedHashes
}

/**
 * Gets the hash for a specific internal asset
 */
export function getInternalAssetHash(assetName: string): string | undefined {
    return computeInternalAssetHashes()[assetName]
}

/**
 * Gets the Dockerfile hash specifically (used for Docker image invalidation)
 */
export function getDockerfileHash(): string {
    return computeInternalAssetHashes()["@dockerfile"]!
}

/**
 * Clears the cached hashes (useful for testing)
 */
export function clearHashCache(): void {
    cachedHashes = null
}


