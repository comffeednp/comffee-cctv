# Comffee CCTV

Free, open-source CCTV recording for small businesses. Your cameras stay at your shop. A small
server in the cloud (it can be a free Oracle Cloud server) records them, keeps the recordings
encrypted for a number of days you choose, deletes older ones by itself, and lets you watch live
or play back recordings from your laptop or phone.

It was made for internet cafes, but it works for any business with IP cameras.

## What it does

- **Live view** of every camera from anywhere, in the browser or as an app on your phone.
- **Cloud recording** in 5-minute pieces, kept for 20 days by default (1 to 90 days, set per
  location). Older recordings are deleted automatically, and the oldest are removed early if the
  disk gets close to full.
- **Encrypted recordings.** Each recording is locked with your own recovery key before it is
  stored. The server cannot open stored recordings, and neither can anyone who copies its disk.
- **Recordings browser** with a calendar and time filter, shown in each location's own time zone.
- **Find cameras for you.** The "Detect cameras" button looks for cameras on the shop network, and
  can add every Tapo camera it finds in one go, each tested first and named Camera 1, Camera 2 and
  so on.
- **Camera login saved once per location.** Enter the camera username and password one time; every
  camera you add there uses it. The password is stored encrypted and never shown again.
- **Recording on or off** per camera and per whole location.
- **Several locations** (branches) in one dashboard.
- **People and permissions.** One owner account plus any number of viewer accounts. Viewers only
  see the locations you give them and cannot change anything.
- **Two-step sign-in for everyone**, account lockout after repeated wrong tries, and an audit log
  of who signed in, watched, downloaded or changed what.
- **Nothing stored at the shop** when you use the router connection: no PC at the shop takes part.

## How it works

```
  At the shop                                Cloud server (the "hub")
  -----------                                ------------------------
  cameras                                    MediaMTX  pulls the video, records 5-minute pieces
     |                                       Hub       encrypts each piece, deletes old ones,
     +-- MikroTik router == WireGuard ==>              runs the dashboard
     |                                       Caddy     HTTPS for the dashboard
     +-- or bridge program -- secure web -->     |
         on any always-on PC                     v
                                     your laptop or phone (dashboard)
```

1. The shop connects **out** to the hub, so it works behind ISP modems and shared (CGNAT)
   internet. Two ways:
   - **Router** (best): a MikroTik router opens an encrypted WireGuard tunnel to the hub. The hub
     can then reach only the cameras, and only their video and ONVIF ports. Nothing else on your
     network, and not the router itself, can be reached. The dashboard writes the router script
     for you. See [docs/ROUTER-SETUP.md](docs/ROUTER-SETUP.md).
   - **Bridge**: a small program on any always-on device at the shop connects to the hub and
     passes camera video through. It only talks to cameras on private addresses and camera ports,
     and never saves video.
2. MediaMTX on the hub pulls each camera's video and writes 5-minute pieces.
3. Every finished piece is encrypted with your recovery key's public half, saved, and the
   unencrypted piece is deleted.
4. To play a recording, your browser downloads the encrypted piece and opens it with your recovery
   key, which lives only on your devices.

## Quick start

You need: a few IP cameras with RTSP (for example TP-Link Tapo), a free Oracle Cloud account, and
either a MikroTik router with RouterOS 7 or an always-on PC at the shop.

1. **Make the cloud server.** Follow [docs/ORACLE-SETUP.md](docs/ORACLE-SETUP.md). It takes about
   30 minutes. The Comffee CCTV desktop app can also create the server and install everything for
   you (it uses [deploy/cloud-init.yaml.template](deploy/cloud-init.yaml.template)); then skip to
   step 3 with the setup code the app gives you.
2. **Install.** Connect to the server and run (use the project's own address from the green "Code"
   button on its GitHub page in place of `<project address>`):

   ```
   sudo apt-get update && sudo apt-get install -y git
   sudo git clone <project address> /opt/comffee-cctv
   sudo bash /opt/comffee-cctv/deploy/install.sh
   ```

   Have your own domain? Point it at the server and add `--host cctv.yourdomain.com`. Without one,
   the installer uses a free address like `203-0-113-10.sslip.io`.
3. **Create the owner account.** Open the address the installer prints and enter the one-time setup
   code it shows. Scan the QR code with an authenticator app (Google Authenticator, Microsoft
   Authenticator, 2FAS or similar).
4. **Make your recovery key.** The dashboard asks for a passphrase and gives you a recovery file.
   Keep the file and the passphrase in two safe places. Recording stays off until this is done.
5. **Add a location** and connect it: paste the router script ([docs/ROUTER-SETUP.md](docs/ROUTER-SETUP.md))
   or start the bridge program.
6. **Add cameras.** On Tapo cameras, first create a camera account in the Tapo app (camera settings,
   Advanced settings, Camera account). Use the same account on every camera of a shop and save it
   once on the location page. Then press "Detect cameras" and add the cameras it finds, or pick each
   camera and choose a quality.

## Honest limits

**Free storage.** An Oracle Always Free server can have about 190 GB of disk. After the system and
the safety reserve the hub keeps free (10% of the disk), about 160 GB is left for recordings. For
2 cameras kept 20 days:

| Quality | Where the video comes from | Typical bitrate | Per camera per day | 2 cameras x 20 days | Fits? |
|---|---|---|---|---|---|
| 360p | camera's small stream | about 0.25 Mbps | about 2.8 GB | about 110 GB | Yes |
| 720p | hub shrinks the big stream | about 0.3 Mbps | about 3.2 GB | about 130 GB | Yes |
| 1080p | camera's big stream | about 1.5 to 2 Mbps | 16 to 22 GB | 650 to 860 GB | No: about 4 to 5 days |

Real numbers depend on the camera and the scene; night vision and busy scenes take more. For more
cameras or days on the free server, use 360p, use fewer days, or add paid storage.

**Upload from the shop.** 720p and 1080p both send the camera's full stream (about 1.5 to 2 Mbps per
camera, around 1.3 TB a month for 2 cameras) because the shrinking to 720p happens on the hub.
360p sends only the small stream (around 170 GB a month for 2 cameras). The router connection caps
its upload (5 Mbps by default) so your customers' internet is not slowed down.

**Tapo cameras cannot send video to your own server.** They only upload to TP-Link's own cloud.
That is why a connector (the router tunnel or the bridge) is needed: it lets the hub pull the video.

**An internet outage at the shop means a gap in the cloud recording.** Nothing reaches the hub
while the shop is offline. A microSD card in each camera, with the camera's own recording turned
on, covers those gaps, but that card is not encrypted by this system and can be stolen with the
camera.

**The hub sees live video.** It has to, to record it. Stored recordings are encrypted, but whoever
controls the server could watch live video. See [docs/PRIVACY.md](docs/PRIVACY.md).

**Lose the recovery key and passphrase, and those recordings can never be opened**, by anyone.

## Documents

- [docs/ORACLE-SETUP.md](docs/ORACLE-SETUP.md): make the free cloud server.
- [docs/ROUTER-SETUP.md](docs/ROUTER-SETUP.md): connect a shop through a MikroTik or other router, or the bridge.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): backups, updates, recovery key, disk space, logs.
- [docs/PRIVACY.md](docs/PRIVACY.md): privacy rules and what the encryption does and does not protect.
- [SECURITY.md](SECURITY.md): reporting security problems and the threat model.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the technical design.

## For developers

Node.js 24 runs the server TypeScript directly. The dashboard is Preact and Vite.

```
npm ci --ignore-scripts
npm run dev:hub          # hub on 127.0.0.1:8080 (needs a hub.json, see deploy/hub.json.example)
npm run dev:dashboard    # dashboard dev server
npm run typecheck
npm test
```

## License

MIT. See [LICENSE](LICENSE).
