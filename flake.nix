{
  description = "xum - coding agent multiplexer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # package.json pins Electron 40.x; keep Electron evaluation permissive
          # so nixpkgs security metadata does not break the devShell before we
          # intentionally move to the next supported Electron line.
          config.allowInsecurePredicate = attrs: builtins.match "electron.*" (attrs.pname or "") != null;
        };

        xum = pkgs.stdenv.mkDerivation rec {
          pname = "xum";
          version = self.rev or self.dirtyRev or "dev";

          src = ./.;

          nativeBuildInputs = with pkgs; [
            bun
            nodejs
            makeWrapper
            gnumake
            git # Needed by scripts/generate-version.sh
            python3 # Needed by node-gyp for native module builds
          ];

          buildInputs = with pkgs; [
            # Pin the major Electron version explicitly so `pkgs.electron`
            # floating to a new major doesn't silently ship the wrong
            # Node.js ABI for our prebuilt native modules.
            electron_40
            stdenv.cc.cc.lib # Provides libstdc++ for native modules like sharp
          ];

          # Fetch dependencies in a separate fixed-output derivation.
          # Include Bun patch files alongside package.json and bun.lock so patched
          # dependencies install identically in local and remote Nix evaluations.
          offlineCache = pkgs.stdenvNoCC.mkDerivation {
            name = "xum-deps-${version}";

            src = pkgs.runCommand "xum-lock-files" { } ''
              mkdir -p $out
              cp ${./package.json} $out/package.json
              cp -r ${./patches} $out/patches
              cp ${./bun.lock} $out/bun.lock
            '';

            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
            ];

            # Don't patch shebangs in node_modules - it creates /nix/store references
            dontPatchShebangs = true;
            dontFixup = true;

            # --ignore-scripts: postinstall scripts (e.g., lzma-native's node-gyp-build)
            # fail in the sandbox because shebangs like #!/usr/bin/env node can't resolve.
            # Native modules are rebuilt in the main derivation after patchShebangs runs.
            buildPhase = ''
              export HOME=$TMPDIR
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/.bun-cache
              bun install --frozen-lockfile --no-progress --ignore-scripts
            '';

            installPhase = ''
              mkdir -p $out
              cp -r node_modules $out/
            '';

            outputHashMode = "recursive";
            # Marker used by scripts/update_flake_hash.sh to update this hash in place.
            outputHash = "sha256-sO6bGZQoHXmiS/lMgKy/p0/nTa8WByUFIUAz8V6WiBU="; # xum-offline-cache-hash
          };

          configurePhase = ''
            export HOME=$TMPDIR
            # Use pre-fetched dependencies (copy so tools can write to it)
            cp -r ${offlineCache}/node_modules .
            chmod -R +w node_modules

            # Patch shebangs in node_modules binaries and scripts
            patchShebangs node_modules
            patchShebangs scripts

            # Run postinstall to rebuild node-pty for Electron
            # (skipped in offlineCache due to --ignore-scripts)
            ./scripts/postinstall.sh

            # Touch sentinel to prevent make from re-running bun install
            touch node_modules/.installed
          '';

          buildPhase = ''
            echo "Building xum with make..."
            export LD_LIBRARY_PATH="${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH"
            # Nix strips .git from the build sandbox, so generate-version.sh's
            # git describe/rev-parse fall back to "unknown". Feed the revision
            # the flake already resolved so the version stamp is accurate.
            export RELEASE_TAG="${version}"
            export XUM_GIT_COMMIT="${builtins.substring 0 12 version}"
            make SHELL=${pkgs.bash}/bin/bash build
          '';

          installPhase = ''
                        mkdir -p $out/lib/xum
                        mkdir -p $out/bin

                        # Copy built files and runtime dependencies
                        cp -r dist $out/lib/xum/
                        cp -r node_modules $out/lib/xum/
                        cp package.json $out/lib/xum/

                        # Ensure vendored binaries have execute permission.
                        # agent-browser's postinstall normally does this, but
                        # --ignore-scripts in offlineCache skips it, and the
                        # Nix store is read-only at runtime so chmod is impossible.
                        chmod +x $out/lib/xum/node_modules/agent-browser/bin/* 2>/dev/null || true

                        # Keep one canonical wrapper and make the old command a symlink so
                        # nix profile upgrades/downgrades never fork the implementation.
                        makeWrapper ${pkgs.electron_40}/bin/electron $out/bin/xum \
                          --add-flags "$out/lib/xum/dist/cli/index.js" \
                          --set XUM_E2E_LOAD_DIST "1" \
                          --prefix LD_LIBRARY_PATH : "${pkgs.stdenv.cc.cc.lib}/lib" \
                          --prefix PATH : ${
                            pkgs.lib.makeBinPath [
                              pkgs.git
                              pkgs.bash
                            ]
                          }
                        ln -s xum $out/bin/mux

                        # Install canonical launcher assets and leave old filenames pointing forward.
                        install -Dm644 public/icon.png $out/share/icons/hicolor/512x512/apps/xum.png
                        ln -s xum.png $out/share/icons/hicolor/512x512/apps/mux.png
                        mkdir -p $out/share/applications
                        cat > $out/share/applications/xum.desktop << EOF
            [Desktop Entry]
            Name=Xum
            GenericName=Coding Agent Multiplexer
            Comment=Coding Agent Multiplexer
            Exec=$out/bin/xum %U
            Icon=xum
            Terminal=false
            Type=Application
            Categories=Development;
            StartupWMClass=xum
            EOF
                        ln -s xum.desktop $out/share/applications/mux.desktop
          '';

          meta = with pkgs.lib; {
            description = "xum - coding agent multiplexer";
            homepage = "https://github.com/coder/mux";
            license = licenses.agpl3Only;
            platforms = platforms.linux ++ platforms.darwin;
            mainProgram = "xum";
          };
        };
      in
      {
        packages.default = xum;
        packages.xum = xum;
        packages.mux = xum;

        formatter = pkgs.nixfmt-rfc-style;

        apps.default = {
          type = "app";
          program = "${xum}/bin/xum";
        };
        apps.xum = {
          type = "app";
          program = "${xum}/bin/xum";
        };
        apps.mux = {
          type = "app";
          program = "${xum}/bin/mux";
        };

        devShells.default = pkgs.mkShell {
          buildInputs =
            with pkgs;
            [
              bun

              # Node + build tooling
              nodejs
              gnumake
              stdenv.cc.cc.lib # Provides libstdc++.so.6 for DuckDB native bindings under Bun

              # Common CLIs
              git
              bash

              # Nix tooling
              nixfmt-rfc-style

              # Repo linting (make static-check)
              go
              hadolint
              shellcheck
              shfmt
              gh
              jq
              duckdb

              # Documentation
              mdbook
              mdbook-mermaid
              mdbook-linkcheck2
              mdbook-pagetoc

              # Browser automation
              agent-browser

              # Terminal bench + browser recording
              uv
              asciinema
              ffmpeg
            ]
            ++ lib.optionals stdenv.isLinux [
              docker
              # The Electron binary shipped in node_modules/electron/dist
              # is dynamically linked against standard FHS paths
              # (libglib-2.0.so.0, libnss3.so, etc.) that don't exist on
              # NixOS, so `make start` / `make dev` fail with "error while
              # loading shared libraries". Expose Nix's autoPatchelf'd
              # Electron and redirect the npm wrapper to it via
              # ELECTRON_OVERRIDE_DIST_PATH below.
              electron_40
            ];

          # Bun does not carry libstdc++ on Linux, so native modules like @duckdb/node-bindings
          # fail to dlopen during tests unless we expose the GCC runtime in the shell.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];

          # Point `node_modules/electron/cli.js` at the Nix-patched Electron
          # binary on Linux so `bunx electron` (used by `make start`/`make dev`)
          # finds its shared libraries on NixOS without needing an FHS wrapper.
          # Left unset on Darwin where the npm-shipped binary runs as-is.
          ELECTRON_OVERRIDE_DIST_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.electron_40}/libexec/electron";
        };
      }
    );
}
