# Changelog

## v0.0.19
This version contains a major overhaul:

### Major Changes
We've moved away from the testing branch, Debian Forky as there were too many issues with it. Instead, we're basing Strux on Debian 13 Trixie, the latest stable branch
that has support until 2030.

In order to take advantage of this build, you'll need to remove the old `strux-builder` docker image, as we now use Debian Trixie for building as well

```
# docker image rm strux-builder
```

### Additional Changes
- We fixed an issue where verbose mode did not output to the new `strux dev` terminal interface
- This fixes the issue related to #6, where intel 
- We now bundle the version of Cage (custom version) and our WPE extension directly into our CLI tool and have it copied over during `strux init`
- We downgraded Cage to use version 0.2.0, as Debian trixie uses wlroots 0.18, which that version of Cage is compatible with

## v0.0.18
We fixed issues with the Docker runner and shell running logic that caused the project to exit before outputting errors to the console. 
This prevented users from seeing build errors in the build process when running `strux dev`.

There was also an error in the default .gitignore in the main image, where go.sum files were excluded from git. Go.sum files should always be added.

## v0.0.17
In this version, we attempt to fix an issue (#5) where Cog doesn't launch in Strux OS. It appears that the issue is related to system proxy mode settings and dbus. 

Modifications:
- Added additional flags to `src/assets/client-base/cage.go` to change the GSettings (which in turn prevents contacting dconf/dbus) to use memory-backed mode.
- Modified `systemd` scripts `strux.service` to remove old remnants from older versions of Strux where we were using a dev watcher service
- Reverted default `inspector:` yaml flags that we changed in v0.0.16 to prevent the use of inspector when creating a new Strux project.

To use this new version of Strux, you'll need to delete `dist/artifacts/client` and `dist/artifacts/systemd` so that Strux can recreate it.
You can also safely re-enable the dev inspector.

## v0.0.16
This version of Strux disables the Strux WPE Inspector by default on new Strux projects. This prevents the issue that keeps resurging (#5).

If you haven't already on an older project, you'll need to add the following to your `strux.yaml`:

```yaml
dev:
    inspector:
        enabled: false
        port: 9223
```