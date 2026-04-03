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
// @ts-ignore
import scriptBuildKernel from "../../assets/scripts-base/strux-build-kernel.sh" with { type: "text" }
// @ts-ignore
import scriptBuildBootloader from "../../assets/scripts-base/strux-build-bootloader.sh" with { type: "text" }

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
import clientGoExec from "../../assets/client-base/exec.go" with { type: "text" }
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

// ============================================================================
// Cage Wayland Compositor Source Files
// ============================================================================
// @ts-ignore
import cageMain from "../../assets/cage-base/cage.c" with { type: "text" }
// @ts-ignore
import cageOutput from "../../assets/cage-base/output.c" with { type: "text" }
// @ts-ignore
import cageOutputH from "../../assets/cage-base/output.h" with { type: "text" }
// @ts-ignore
import cageSeat from "../../assets/cage-base/seat.c" with { type: "text" }
// @ts-ignore
import cageSeatH from "../../assets/cage-base/seat.h" with { type: "text" }
// @ts-ignore
import cageView from "../../assets/cage-base/view.c" with { type: "text" }
// @ts-ignore
import cageViewH from "../../assets/cage-base/view.h" with { type: "text" }
// @ts-ignore
import cageXdgShell from "../../assets/cage-base/xdg_shell.c" with { type: "text" }
// @ts-ignore
import cageXdgShellH from "../../assets/cage-base/xdg_shell.h" with { type: "text" }
// @ts-ignore
import cageXwayland from "../../assets/cage-base/xwayland.c" with { type: "text" }
// @ts-ignore
import cageXwaylandH from "../../assets/cage-base/xwayland.h" with { type: "text" }
// @ts-ignore
import cageIdleInhibit from "../../assets/cage-base/idle_inhibit_v1.c" with { type: "text" }
// @ts-ignore
import cageIdleInhibitH from "../../assets/cage-base/idle_inhibit_v1.h" with { type: "text" }
// @ts-ignore
import cageSplash from "../../assets/cage-base/splash.c" with { type: "text" }
// @ts-ignore
import cageSplashH from "../../assets/cage-base/splash.h" with { type: "text" }
// @ts-ignore
import cageServerH from "../../assets/cage-base/server.h" with { type: "text" }
// @ts-ignore
import cageConfigH from "../../assets/cage-base/config.h.in" with { type: "text" }
// @ts-ignore
import cageMesonBuild from "../../assets/cage-base/meson.build" with { type: "text" }
// @ts-ignore
import cageMesonOptions from "../../assets/cage-base/meson_options.txt" with { type: "text" }
// @ts-ignore
import cageManPage from "../../assets/cage-base/cage.1.scd" with { type: "text" }
// @ts-ignore
import cageReadme from "../../assets/cage-base/README.md" with { type: "text" }

// ============================================================================
// WPE WebKit Extension Source Files
// ============================================================================
// @ts-ignore
import wpeExtensionC from "../../assets/wpe-extension-base/extension.c" with { type: "text" }
// @ts-ignore
import wpeExtensionCMake from "../../assets/wpe-extension-base/CMakeLists.txt" with { type: "text" }
// @ts-ignore
import cogAutoplayPatch from "../../assets/scripts-base/artifacts/patches/cog-autoplay-policy.patch" with { type: "text" }

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
        "@build-kernel-script": hashStrings(scriptBuildKernel),
        "@build-bootloader-script": hashStrings(scriptBuildBootloader),

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
            clientGoExec,
            clientGoMod,
            clientGoSum
        ),

        // Cage Wayland compositor sources
        "@cage-sources": hashStrings(
            cageMain,
            cageOutput,
            cageOutputH,
            cageSeat,
            cageSeatH,
            cageView,
            cageViewH,
            cageXdgShell,
            cageXdgShellH,
            cageXwayland,
            cageXwaylandH,
            cageIdleInhibit,
            cageIdleInhibitH,
            cageSplash,
            cageSplashH,
            cageServerH,
            cageConfigH,
            cageMesonBuild,
            cageMesonOptions,
            cageManPage,
            cageReadme
        ),

        // WPE WebKit extension sources + Cog autoplay patch
        "@wpe-extension-sources": hashStrings(
            wpeExtensionC,
            wpeExtensionCMake,
            cogAutoplayPatch
        ),

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
