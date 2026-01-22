# Changelog

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