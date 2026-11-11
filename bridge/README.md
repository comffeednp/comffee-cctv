# Comffee CCTV bridge

The bridge is a small program for an always-on device at the business (a PC, a mini PC, a Raspberry Pi).
It connects **out** to the hub over an encrypted WebSocket (`wss://<hub>/bridge`) and relays camera
connections when the hub asks for them. Use it when the router cannot run the router connector.

What it will and will not do:

- It only opens connections to **private IPv4 addresses** (10.x, 172.16-31.x, 192.168.x) on ports
  **554** (RTSP), **2020** (ONVIF on Tapo), **80** and **8000**. Anything else is refused by the bridge
  itself, whatever the hub asks.
- At most 32 connections at a time.
- It never writes video to disk; bytes pass through memory only.
- "Detect cameras" on the hub asks the bridge to look for cameras: an ONVIF WS-Discovery probe plus a
  scan of this device's local /24 networks on ports 554 and 2020.

## Get a token

On the hub dashboard, open the location (connector: bridge) and make a bridge token. The token
is shown once. Making a new token cuts off the old one at once.

## Quick start (any system)

```
comffee-cctv-bridge --hub wss://cctv.example.com/bridge --token <token>
```

Options: `--hub`, `--token` (or the `COMFFEE_CCTV_BRIDGE_TOKEN` environment variable), `--name` (shown
on the location page, default: the computer name), `--config <file>`, `--help`, `--version`.

The config file is JSON:

```json
{ "hub": "wss://cctv.example.com/bridge", "token": "<token>", "name": "front desk" }
```

## Windows

1. Put `comffee-cctv-bridge.exe` and `install-windows.ps1` in one folder.
2. Open PowerShell with **Run as administrator** in that folder and run:

   ```
   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Hub wss://cctv.example.com/bridge
   ```

   It asks for the token. The script copies the program to `Program Files\Comffee CCTV Bridge`, writes
   the config to `ProgramData\Comffee CCTV Bridge\bridge.json` (readable only by administrators, SYSTEM
   and the bridge), and registers the startup task **Comffee CCTV Bridge**. The task runs as
   `LOCAL SERVICE`, starts with Windows and restarts after a failure.
3. Run the script again to update the program or the token. Remove it with `uninstall-windows.ps1`.

## Linux (systemd)

Follow the steps at the top of `comffee-cctv-bridge.service`. The service runs as a throwaway system user
(`DynamicUser`) with no extra privileges, and reads the config through systemd `LoadCredential`, so the
token file stays readable by root only.

## Building

From the repository root:

```
npm run build:bridge                  # single executable for this computer
node bridge/build.mjs --bundle-only   # only the bundled script, runnable with: node bridge/dist/comffee-cctv-bridge.cjs
```

The single executable is Node 24 with the bundled script injected (Node single executable applications
plus postject). Build on Windows for the `.exe` and on Linux (x64 or arm64) for Linux. The copied Node
signature no longer matches after injection, so sign the Windows program yourself if you publish it.

## How it talks to the hub

The protocol is in `shared/bridge-protocol.ts`. The bridge sends `Authorization: Bearer <token>` on the
WebSocket request and a `hello` message first; the hub answers `welcome`. Control messages are JSON text
frames; relayed bytes are binary frames (`u32 stream id` followed by the bytes), with `pause` and
`resume` for flow control. The hub pings every 20 seconds; a connection silent for 60 seconds is
dropped and the bridge reconnects with backoff (1 second doubling to 30 seconds).
