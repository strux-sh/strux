{
  description = "Strux OS - A Framework for Building Kiosk-Style Operating Systems";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        # Read version from package.json - single source of truth
        packageJson = builtins.fromJSON (builtins.readFile ./package.json);
        baseVersion = packageJson.version;

        # For development builds, append git info to distinguish from releases
        # - Clean git tree: "0.1.0+abc1234"
        # - Dirty tree: "0.1.0-dev"
        # - Release (when CI sets STRUX_VERSION): uses package.json version directly
        version =
          if self ? rev then
            "${baseVersion}+${self.shortRev}"
          else
            "${baseVersion}-dev";

        # Source filtering to exclude build artifacts
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            let
              baseName = baseNameOf path;
            in
            # Exclude build artifacts and caches
            !(baseName == "node_modules" ||
              baseName == ".git" ||
              baseName == "result" ||
              (type == "regular" && baseName == "strux") ||
              (type == "regular" && baseName == "strux-introspect"));
        };

        # Go binary: strux-introspect
        strux-introspect = pkgs.buildGoModule {
          pname = "strux-introspect";
          inherit version src;

          # Build only the introspection command
          subPackages = [ "cmd/strux" ];

          # No external Go dependencies
          vendorHash = null;

          # Static linking - use env attribute for CGO_ENABLED
          env = {
            CGO_ENABLED = "0";
          };

          ldflags = [ "-s" "-w" ];

          postInstall = ''
            mv $out/bin/strux $out/bin/strux-introspect
          '';

          meta = with pkgs.lib; {
            description = "Strux OS Go introspection helper";
            homepage = "https://github.com/strux-dev/strux";
            license = licenses.mit;
            platforms = platforms.unix;
          };
        };

        # Fixed-output derivation for Bun dependencies
        # This hash needs to be updated when bun.lock changes
        # Run: nix build .#bunDeps --rebuild to get the new hash
        bunDeps = pkgs.stdenvNoCC.mkDerivation {
          pname = "strux-bun-deps";
          inherit version src;

          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];

          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            bun install --frozen-lockfile
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r node_modules $out/
            runHook postInstall
          '';

          # Fixed-output derivation - requires network access
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          # This hash needs to be updated when bun.lock changes
          # Run: nix build .#bunDeps 2>&1 | grep "got:" to get the new hash
          outputHash = "sha256-nAroCA2wTbtCZywJh0m0PGLFKzTQHPsBXnd/IhC7pcs=";
        };

        # Bun CLI: strux
        strux-cli = pkgs.stdenvNoCC.mkDerivation {
          pname = "strux";
          inherit version src;

          nativeBuildInputs = [
            pkgs.bun
            pkgs.go
          ];

          buildPhase = ''
            runHook preBuild

            export HOME=$TMPDIR

            # Use pre-fetched dependencies
            cp -r ${bunDeps}/node_modules .
            chmod -R +w node_modules

            # Generate runtime types using Go
            go run ./cmd/gen-runtime-types -format=ts > src/types/strux-runtime.ts

            # Inject version directly into version.ts before compiling
            # This is more reliable than --define which has escaping issues
            cat > src/version.ts << 'VERSIONEOF'
/***
 *
 *  Strux Version Detection
 *
 */

// Version injected at build time by Nix
export const STRUX_VERSION = "${version}"
VERSIONEOF

            # Build the CLI binary
            bun build src/index.ts --compile --outfile strux

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin
            cp strux $out/bin/
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Strux OS CLI - Build kiosk-style Linux images";
            homepage = "https://github.com/strux-dev/strux";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "strux";
          };
        };

        # Combined package with both binaries
        strux = pkgs.symlinkJoin {
          name = "strux-${version}";
          paths = [ strux-cli strux-introspect ];

          meta = with pkgs.lib; {
            description = "Strux OS - A Framework for Building Kiosk-Style Operating Systems";
            homepage = "https://github.com/strux-dev/strux";
            license = licenses.mit;
            platforms = platforms.unix;
            mainProgram = "strux";
          };
        };

      in
      {
        packages = {
          inherit strux strux-cli strux-introspect bunDeps;
          default = strux;
        };

        # Development shell with all required tools
        devShells.default = pkgs.mkShell {
          buildInputs = [
            # Core build tools
            pkgs.go
            pkgs.bun

            # Node.js for frontend development (Vite, etc.)
            pkgs.nodejs

            # Development utilities
            pkgs.git
            pkgs.gnumake
          ];

          shellHook = ''
            echo "Strux OS Development Environment"
            echo ""
            echo "Available tools:"
            echo "  go       $(go version | cut -d' ' -f3)"
            echo "  bun      $(bun --version)"
            echo "  node     $(node --version)"
            echo ""
            echo "Quick commands:"
            echo "  bun run dev          - Run CLI in development mode"
            echo "  bun run build        - Build the CLI binary"
            echo "  bun run build:go     - Build the Go helper binary"
            echo "  bun test             - Run tests"
            echo ""
          '';
        };

        # Expose as an app for `nix run`
        apps.default = flake-utils.lib.mkApp {
          drv = strux;
          name = "strux";
        };
      }
    );
}
