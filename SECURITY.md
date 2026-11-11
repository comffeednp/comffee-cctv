# Security

## Reporting a problem

Please do not report security problems in public issues.

Use GitHub's private reporting instead: open the project's **Security** tab and choose **Report a
vulnerability**. Include:

- what an attacker can do and what they need first (an account, a position on the shop network,
  and so on),
- the steps to reproduce it,
- the version or commit you tested.

We will reply as soon as we can, work on a fix with you, and agree on when the problem is made
public. Only the newest release gets security fixes.

## Threat model in short

### What is protected

- **The dashboard from the internet.** Only HTTPS (80 and 443), the WireGuard port (UDP 51820) and
  the live video port (UDP 8189) are open. Everyone signs in with a password and a mandatory
  two-step code. Wrong passwords are limited per name and network (5 in 15 minutes) and per name
  from everywhere (100 in 15 minutes), wrong two-step codes lock the account for 15 minutes, and an
  address with 20 failures waits 15 minutes. Session cookies are HttpOnly, Secure and
  SameSite=Strict, every changing request needs a custom header, and pages run under a strict
  Content Security Policy.
- **Stored recordings.** Each 5-minute piece is encrypted with a fresh AES-256-GCM key, which is
  locked with the owner's RSA-OAEP 3072 public key. The private half (the recovery key) is made in
  the owner's browser and never reaches the server. A stolen disk or backup does not reveal
  recordings.
- **Secrets in the database.** Camera passwords and two-step secrets are sealed with a key kept in a
  separate file. A copy of the database alone does not reveal them.
- **Viewer accounts.** Viewers only see the locations they were given and cannot change anything.
  Other locations look like they do not exist.
- **The shop network.** The router script lets the tunnel reach only the camera network, only on
  ports 554 and 2020, and blocks everything else including the router itself. The bridge program
  only connects to private addresses on camera ports, at most 32 streams at once, and never writes
  video to disk. On the hub, new connections arriving through the tunnel are dropped.
- **Live video links.** Each live view needs a token for exactly that camera, signed by the hub and
  valid for 60 seconds. The media server's own pages and API are not reachable from outside.
- **Installation.** Node.js and MediaMTX are pinned and checked against hashes written in the
  installer and against each release's checksum list. Caddy comes from its signed package
  repository, checked by key fingerprint. Libraries install from the lock file with install
  scripts turned off. The services run as their own account, cannot change the program files, and
  are sandboxed by systemd.

### Known limits

- **Whoever controls the hub server can watch live video**, read the last few minutes of video
  before they are encrypted, and read camera passwords. This includes the cloud provider and anyone
  who breaks into the server.
- **Anyone with the recovery file and its passphrase can open every recording made with that key.**
- **A device that has imported the recovery key can open recordings** while it is signed in. Use
  only your own devices and keep them locked.
- **Recording details are not secret:** which camera, when, and how big each piece is.
- **The cameras themselves are out of scope:** their firmware, their passwords, their makers'
  clouds, and any microSD card inside them.
- **With the "direct" connection** (hub on the same network as the cameras) camera video crosses
  that network unencrypted, as with any RTSP camera.
- **Flooding attacks** against the server's internet connection are not prevented.
- **Use a different camera login at each location.** The media server follows an RTSP redirect
  from a camera address, so a device that takes over a camera address at one location might point
  the hub at a camera of another location. Different camera logins per location stop that camera
  from opening.
- **The default web address trusts sslip.io.** Without your own domain the hub uses
  `<public-ip-with-dashes>.sslip.io`, a free public name service. Whoever controls sslip.io could get
  a certificate for that name and sit between you and the hub. Use your own domain (`--host`) for
  stronger protection.
- **Updates trust the project's git repository** over HTTPS; commits and tags are not signature
  checked by the updater.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the same limits in plain words, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.
