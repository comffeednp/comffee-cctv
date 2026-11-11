# Comffee CCTV architecture

Comffee CCTV is an open-source (MIT) CCTV system for small businesses: internet cafes first, but any
business with IP cameras. It gives live view, encrypted cloud recording with automatic deletion, and
remote access from a laptop or phone.

The source of truth for types and constants is in code:

- `shared/api-types.ts`: every HTTP request and response type.
- `shared/vault-format.ts`: the CCV1 encrypted recording format and the recovery file.
- `shared/bridge-protocol.ts`: the hub to bridge WebSocket protocol.
- `server/src/contracts.ts`: database schema, hub config, secrets and the server service interfaces.

## 1. Overview

A **hub** runs on a cloud VM (Ubuntu 24.04, x86_64 or arm64; an Oracle Cloud Always Free VM works).
Cameras stay on the business network. The hub pulls each camera's RTSP stream through a **connector**,
records it into encrypted 5-minute segments, keeps them for N days (per location, 1 to 90, default 20)
and deletes older ones automatically.

The **dashboard** is an installable web app (PWA) served by the hub. It offers live view, a recordings
browser sorted and filtered by date and time, camera detection ("Detect cameras"), recording on and off
per camera and per location, and any number of locations.

With the router connector nothing is stored at the business and no business PC takes part.

## 2. Repository layout

| Path | Contents |
| --- | --- |
| `package.json` | Scripts: `dev:hub`, `dev:dashboard`, `build:dashboard`, `build:bridge`, `typecheck`, `test` |
| `tsconfig.json` | Type checking for `server/`, `bridge/`, `shared/` |
| `dashboard/tsconfig.json`, `dashboard/vite.config.ts` | Dashboard build |
| `shared/*.ts` | Pure TypeScript used by both Node and the browser |
| `server/src/**`, `server/test/**` | The hub |
| `bridge/**` | The bridge program |
| `dashboard/**` | The dashboard (Preact, Vite) |
| `deploy/**` | Installer, MediaMTX template, systemd units, Caddy config |
| `docs/*.md` | Documentation |
| `README.md`, `SECURITY.md`, `LICENSE` | Project files |

Runtime dependencies: fastify 5, @fastify/static, @fastify/websocket, preact, qrcode-generator.
Development dependencies: typescript, @types/node 24, vite, @preact/preset-vite, esbuild, postject.
The database is `node:sqlite` (`DatabaseSync`). Nothing else is added without a strong reason.

Node 24 runs the server TypeScript directly (built-in type stripping), so server, bridge and shared code
use erasable syntax only: no `enum`, `namespace`, parameter properties or decorators; relative imports
include the `.ts` extension; type-only imports use `import type`.

## 3. Connectors

Each location has one connector (`locations.connector`).

### Router

The business router opens an outbound WireGuard tunnel to the hub, so it works behind ISP modems and
CGNAT.

- Hub interface `wg0` = `10.77.0.1/16`, UDP port 51820.
- Each router location gets a slot S (1 to 250). The router's tunnel address is `10.77.S.2`.
- The router maps `10.78.S.0/24` one-to-one onto the real camera subnet with RouterOS `netmap`. The camera
  subnet must be exactly a /24.
- Hub peer allowed-ips: `10.77.S.2/32` and `10.78.S.0/24`; hub route `10.78.S.0/24 dev wg0`.
- The router firewall lets the tunnel reach only the camera subnet on TCP 554 and 2020. Everything else
  from the tunnel is dropped, including traffic to the router itself.
- The router caps upload on the tunnel (default 5000 kbps, lowest priority 8).
- Optionally a RouterOS routing table makes the tunnel use a chosen internet line.
- The hub generates the router script and an undo script (section 13). RTSP always runs over TCP.

### Bridge

A small program on any always-on device at the business connects out to `wss://<hub>/bridge` with a
location token. The hub asks it to open TCP connections to camera IP:port and the bridge relays the
bytes.

- The bridge refuses any target that is not an RFC 1918 private IPv4 address, or not port 554, 2020,
  80 or 8000. It allows at most 32 concurrent streams and never writes video to disk.
- Detection on the bridge: ONVIF WS-Discovery multicast probe, plus a TCP scan of its local /24
  networks on ports 554 and 2020.
- On the hub, each bridged camera gets a local relay listener on `127.0.0.1:<ephemeral port>`.
  MediaMTX and ffprobe connect there.
- Wire protocol: `shared/bridge-protocol.ts`. The first message is `hello` with the token (not in the
  URL); text frames are JSON control messages; binary frames are `u32 stream id || bytes`.

### Direct

The hub reaches camera IPs itself (hub on the same network, or development). Detection scans
`location.camera_subnet` (at most a /24).

### Camera address

`ConnectorService.resolveCameraAddress(locationId, lanIp, port)` returns the host and port the hub uses:

- router: `10.78.S.<last octet of lanIp>:port`
- bridge: `127.0.0.1:<relay port>`
- direct: `lanIp:port`

## 4. Hub data layout

`config.dataDir`, default `/var/lib/comffee-cctv`:

| Path | Contents |
| --- | --- |
| `db.sqlite` | Database |
| `raw/<pathName>/<files>` | Plain fMP4 segments MediaMTX writes; encrypted and removed by the sweeper |
| `vault/<locationId>/<cameraId>/<YYYY-MM-DD UTC>/<startMs>.ccv` | Encrypted recordings |
| `secrets/master.key` | 32 random bytes, seals TOTP secrets, camera passwords and each location's saved camera password |
| `secrets/stream-token.key` | 32 random bytes, signs live tokens |
| `secrets/mediamtx-internal.json` | `{"user","password"}` the hub and its ffmpeg jobs use with MediaMTX |

Secrets have mode 0600 and are created on first start if missing. MediaMTX and the hub run as the same
system user `comffee-cctv`. Servers run in UTC.

Config file: `/etc/comffee-cctv/hub.json` (or the path in `COMFFEE_CCTV_CONFIG`). Keys and defaults are
`HubConfig` and `HUB_CONFIG_DEFAULTS` in `server/src/contracts.ts`. `bridgeDownloadUrl` (an `https://`
address or null, default null) is the bridge download page shown on bridge locations; nothing in the
code points at one particular project or business.

Command line: `node server/src/main.ts` runs the hub; `node server/src/main.ts setup-code` prints a
one-time setup code and exits; `setup-code --code <code>` registers a code made elsewhere instead
(base32, 26 to 64 characters, stored hashed, never printed), which the unattended install uses.

## 5. Database

The schema is `SCHEMA_SQL` in `server/src/contracts.ts`: tables `meta`, `users`, `locations`,
`user_locations`, `sessions`, `login_challenges`, `ip_failures`, `setup_codes`, `audit_log`,
`vault_keys`, `cameras`, `segments`. Every open runs `PRAGMA journal_mode=WAL`, `foreign_keys=ON`,
`busy_timeout=5000`. `meta.schema_version` holds `SCHEMA_VERSION`.

`users`, `locations` and `cameras` use `INTEGER PRIMARY KEY AUTOINCREMENT`, so a deleted row's id is
never given out again (live paths, recordings and audit targets are keyed by these ids). Recording
queries also keep only segments that start at or after the camera row's `created_at`.

`locations.camera_username` and `locations.camera_password_enc` hold the location's saved camera login
(the password sealed with the master key). Both are null when none is saved.

All stored times are unix milliseconds UTC. The API returns ISO 8601 UTC strings. The dashboard shows
times in the location's IANA timezone.

## 6. Accounts and access

### Roles

- Exactly one **owner**, created at setup, who can do everything.
- Any number of **viewers**. A viewer sees only the locations listed for them in `user_locations`, may
  watch live and recorded video of those locations, and may change only their own password and 2-step
  code. A viewer may not switch recording, run detection, add, edit or remove cameras or locations, or
  see users, storage or the audit log.
- A viewer asking for a location, camera or recording outside their list gets 404 (not 403), so
  existence does not leak.

### Passwords

- 12 to 200 characters.
- scrypt N=32768, r=8, p=1, key length 64, maxmem 64 MiB, 16-byte salt, stored as
  `scrypt$32768$8$1$<saltB64>$<hashB64>`, compared with `timingSafeEqual`.
- Unknown usernames still run scrypt against a dummy hash. The error text is always
  "Wrong username or password".

### 2-step codes (mandatory for everyone)

- TOTP per RFC 6238: SHA-1, 6 digits, 30 seconds, accepted window plus or minus one step, replay guard
  via `users.totp_last_step`.
- Secret: 20 random bytes, base32, stored sealed with the master key.
- otpauth URL issuer "Comffee CCTV", label "Comffee CCTV:<username>".

### Login

1. `POST /api/auth/login {username, password}` returns `{next:'totp', challenge}`, or for a user without
   2-step yet `{next:'enroll-totp', challenge, secretBase32, otpauthUrl}`.
2. `POST /api/auth/totp {challenge, code}` returns `Me` and sets the session cookie.

Challenges are 32 random bytes (base64url), stored as SHA-256 hex, expire after 5 minutes, are single
use, and have a purpose: `login`, `enroll`, `setup` or `reset`.

### Throttling

- Wrong passwords are counted per typed name (stored hashed, the same for unknown names): 5 from one IP
  within 15 minutes block that name from that IP for 15 minutes, and 100 from all IPs block it
  everywhere. One network therefore cannot lock an account out for everyone.
- 5 wrong 2-step codes for one user within 15 minutes lock that user for 15 minutes
  (`users.locked_until`).
- 20 failures from one IP within 15 minutes give that IP 429 for 15 minutes (`ip_failures`, kind
  `login`).
- Setup code: at most 10 tries per IP per hour (kind `setup`).
- Bridge socket: 10 failed token tries per IP per 15 minutes (kind `bridge`).
- Detection: at most 1 running and 6 per hour per location. Camera tests: 30 per hour per user.

### Sessions

- Cookie `ccv_session` = 32 random bytes base64url; the database stores its SHA-256 hex.
- HttpOnly, Secure (unless `config.devInsecureCookies`), SameSite=Strict, Path=/.
- Idle timeout 12 hours, absolute limit 7 days. A new session id at every login.
- A password change deletes the user's other sessions. Disabling or deleting a user deletes their
  sessions.

### First setup

- The hub command `setup-code` prints a one-time code (base32, 128 bits, valid 24 hours, stored hashed).
  `setup-code --code <code>` stores the hash of a code made elsewhere (the desktop app, through
  `install.sh --setup-code`), valid 30 days from then; a used code cannot be registered again.
- `GET /api/setup/status` returns `{needsSetup, hasVaultKey}`; `needsSetup` is true while no owner exists.
- `POST /api/setup/owner {setupCode, username, password}` creates the owner (only if none exists),
  consumes the code and returns an enrollment `{challenge, secretBase32, otpauthUrl}` (purpose `setup`).
  `POST /api/auth/totp` completes it and signs in.
- If setup stops after the owner was created, the owner signs in normally and gets `next:'enroll-totp'`.

### Password re-check

These actions require the caller's password in the body: `PUT /api/keys/vault`,
`DELETE /api/locations/:id`, `PATCH /api/users/:id` with a password or 2-step reset, and
`POST /api/me/totp/reset`. A wrong password returns 422 `wrong_password`.

### Request protection

- CSRF: every non-GET/HEAD request under `/api` must carry `X-CCTV: 1`; when an `Origin` header is
  present it must equal `config.publicOrigin`; bodies must be JSON. Otherwise 403 `csrf`.
- Security headers on every hub response:
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
    `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Cache-Control: no-store` on `/api`.
- Body limit 64 KB. Fastify trusts the proxy only from 127.0.0.1 (Caddy in front).

### Errors

Body `{"error":{"code","message"}}`. Status codes: 401 not signed in, 403 owner only or CSRF, 404 not
found or no access, 409 conflict, 422 invalid input or wrong password, 429 throttled, 503 a dependency
did not answer. Codes are listed in `ApiErrorCode`.

### Audit log

The owner can read it. Each row stores the user id, a username snapshot, IP and user agent. Recorded
actions (`AuditAction`): login success and failure, logout, 2-step enrollment, setup, password change,
2-step reset, user create, update and delete, vault key set, location create, update and delete, bridge
token rotation, detection run, saved camera login saved or removed (`location.camera_login`, detail
`saved` or `removed`, never the values), camera create (also each camera added from a detection),
update and delete, recording on and off (camera and location), live view start (camera), recording
file download (segment id), storage prune.

## 7. HTTP API

JSON throughout; types in `shared/api-types.ts`. Lists come wrapped in an object (`{users}`,
`{locations}`, `{cameras}`, `{keys, activeKeyId}`, `{items, nextCursor}`, `{days}`, `{devices}`).

**Public**

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/setup/status` | | `SetupStatus` |
| `POST /api/setup/owner` | `SetupOwnerRequest` | `TotpEnrollment` |
| `POST /api/auth/login` | `LoginRequest` | `LoginResponse` |
| `POST /api/auth/totp` | `TotpRequest` | `Me` + cookie |
| `GET /bridge` | WebSocket, bridge token in `hello` | |
| `POST /internal/mediamtx-auth` | MediaMTX auth hook, 127.0.0.1 only | 200 or 401 |

**Signed in (owner or viewer)**

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /api/auth/logout` | | `OkResponse` |
| `GET /api/me` | | `Me` |
| `POST /api/me/password` | `ChangePasswordRequest` | `OkResponse` |
| `POST /api/me/totp/reset` | `ResetTotpRequest` | `TotpEnrollment` (purpose `reset`, completed by `POST /api/auth/totp`) |
| `GET /api/keys/vault` | | `VaultKeysResponse` |
| `GET /api/locations` | | `LocationsResponse` (viewer: own only) |
| `GET /api/locations/:id` | | `LocationSummary` |
| `GET /api/cameras?locationId=` | | `CamerasResponse` |
| `POST /api/live/:cameraId/token` | | `LiveTokenResponse` |
| `GET /api/recordings?locationId&cameraId&from&to&order=asc\|desc&limit&cursor` | limit at most 500 | `RecordingsPage` |
| `GET /api/recordings/days?locationId&cameraId&month=YYYY-MM` | days in the location timezone | `RecordingDaysResponse` |
| `GET /api/recordings/:id/file` | | CCV1 bytes, `application/octet-stream`, `Content-Length`, audited |

**Owner only**

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/users` | | `UsersResponse` |
| `POST /api/users` | `CreateViewerRequest` | `UserSummary` |
| `PATCH /api/users/:id` | `UpdateUserRequest` | `UserSummary` |
| `DELETE /api/users/:id` | | `OkResponse` |
| `GET /api/audit?limit&cursor` | | `AuditPage` |
| `PUT /api/keys/vault` | `SetVaultKeyRequest` | `VaultKeyInfo` |
| `POST /api/locations` | `CreateLocationRequest` | `LocationSummary` |
| `PATCH /api/locations/:id` | `UpdateLocationRequest` | `LocationSummary` |
| `DELETE /api/locations/:id` | `DeleteLocationRequest` | `OkResponse` |
| `GET /api/locations/:id/setup` | | `LocationSetup` |
| `POST /api/locations/:id/bridge-token` | | `BridgeTokenResponse` |
| `POST /api/locations/:id/detect` | | `DetectResponse` |
| `POST /api/locations/:id/cameras/add-detected` | `AddDetectedRequest` | `AddDetectedResponse` |
| `POST /api/cameras` | `CreateCameraRequest` | `CameraSummary` |
| `PATCH /api/cameras/:id` | `UpdateCameraRequest` | `CameraSummary` |
| `DELETE /api/cameras/:id` | | `OkResponse` |
| `POST /api/cameras/test` | `CameraTestRequest` | `CameraTestResponse` |
| `POST /api/cameras/:id/test` | | `CameraTestResponse` |
| `GET /api/storage` | | `StorageResponse` |

## 8. MediaMTX

MediaMTX (a pinned release) is the media server. Its base config is `deploy/mediamtx.yml.template`
with placeholders `{{DATA_DIR}}` and `{{PUBLIC_IP}}`. Every key name is checked against the pinned
version's documented configuration.

- `apiAddress 127.0.0.1:9997`. Metrics, pprof, playback, RTMP, HLS and SRT are off.
- RTSP on `127.0.0.1:8554`, TCP only.
- WebRTC on `127.0.0.1:8889`, `webrtcLocalUDPAddress :8189`, `webrtcAdditionalHosts [{{PUBLIC_IP}}]`.
- `authMethod http`, `authHTTPAddress http://127.0.0.1:8080/internal/mediamtx-auth`, nothing excluded.
- Recording defaults: `recordFormat fmp4`, `recordSegmentDuration 5m`,
  `recordPath {{DATA_DIR}}/raw/%path/%Y-%m-%d_%H-%M-%S-%f` (UTC), `recordDeleteAfter 0` (the hub deletes).

### Paths

- `c<cameraId>` is the path that is viewed and recorded.
- 360p: its source is the camera sub stream. 1080p: the main stream.
- 720p: a second path `c<cameraId>_src` pulls the main stream, and an ffmpeg `runOnInit` job (restarted
  on exit) transcodes it to 720p H.264 (about 300 kbps, 15 fps, no audio) and publishes it to
  `c<cameraId>` with the internal credentials.
- Camera passwords go into source URLs, URL-encoded.
- Recording on (camera recording on, location not paused, and an active vault key exists): record yes,
  source always on. Off: record no, source on demand (pulled only while someone watches).
- The hub manages paths only through the MediaMTX API (with the internal credentials) and reconciles at
  start and every 60 seconds.

### Auth hook decisions

1. Request not from 127.0.0.1: deny.
2. Internal user and password (constant-time compare) from 127.0.0.1: allow any action.
3. Action `read` over `webrtc` with a valid live token for exactly that path, whose user still exists,
   is not disabled, and still has access to that camera's location: allow.
4. Everything else: deny (401).

### Live tokens

`"v1." + base64url(JSON {p: path, u: userId, e: expiresMs}) + "." + base64url(HMAC-SHA256(stream-token.key, first two parts))`,
valid 60 seconds. `POST /api/live/:cameraId/token` returns `{whepUrl: "/live/c<id>/whep", token, expiresAt}`;
the browser sends `Authorization: Bearer <token>` on the WHEP request. Caddy forwards only
`/live/<path>/whep` and `/live/<path>/whep/<session>` to `127.0.0.1:8889`, with the `/live` prefix
stripped.

## 9. Recording pipeline

- **Sweeper, every 15 seconds.** In each `raw/<path>/`, every file except the newest is complete; the
  newest is complete once its modification time is more than 6 minutes old. Start time comes from the
  file name (UTC). Duration = next file's start minus this start, or for the last file, modification
  time minus start. The file is encrypted with the active vault key (streaming, 1 MiB chunks) into the
  vault, the `segments` row is inserted (with a camera name snapshot), then the raw file is deleted. For
  an unknown camera, or when no active key exists, the raw file is deleted.
- **Retention, hourly and at start.** Segments whose `start_at + duration_ms` is older than the
  location's `retention_days` are deleted.
- **Disk guard.** If free space falls below max(10% of the disk, 5 GiB), the oldest segments across all
  locations are deleted until it is above again, and `storage.prune` is audited.
- Deleting a camera keeps its segments until retention removes them.

## 10. Vault file format CCV1

Implemented in `shared/vault-format.ts`; the hub writes it with `node:crypto`, the browser reads it with
WebCrypto. All integers are big-endian.

**Header**

| Field | Size |
| --- | --- |
| Magic `CCV1` | 4 |
| headerLength u32 (whole header, magic included) | 4 |
| keyId | 16 |
| wrappedKeyLength u16 | 2 |
| wrappedKey: RSA-OAEP SHA-256 encryption of a fresh random 32-byte AES-256 key | wrappedKeyLength |
| noncePrefix, random | 8 |
| chunkSize u32 (1048576) | 4 |
| metaLength u32 | 4 |
| meta: UTF-8 JSON `{"v":1,"cameraId","locationId","start" (ISO),"durationMs","mime":"video/mp4"}` | metaLength |

**Body.** The plaintext of P bytes is split into `floor(P / chunkSize) + 1` chunks, so the last chunk
holds `P mod chunkSize` bytes (possibly 0). Each chunk is AES-256-GCM ciphertext followed by its 16-byte
tag, with:

- nonce = noncePrefix || u32 chunk index
- AAD = full header bytes || u32 chunk index || u8 (1 for the last chunk, else 0)

The AAD binds every chunk to its header, position and the end of the file, so truncation, reordering
and header edits are detected.

**keyId** = first 16 bytes of SHA-256 of the public key's SPKI DER, shown as hex in the API.

## 11. Recovery key

The owner's private key never reaches the hub.

- At setup the browser generates an RSA-OAEP 3072 / SHA-256 key pair. The public key (SPKI, base64) is
  sent to `PUT /api/keys/vault`.
- The private key (PKCS8) is encrypted with a passphrase of at least 12 characters: PBKDF2-SHA-256 with
  600000 iterations and a 16-byte salt derives an AES-256-GCM key; the IV is 12 bytes.
- Recovery file JSON (base64 fields):
  `{"format":"comffee-cctv-recovery","version":1,"keyId","kdf":{"name":"PBKDF2","hash":"SHA-256","iterations":600000,"salt"},"cipher":{"name":"AES-GCM","iv"},"data","createdAt"}`.
- The browser keeps an imported private key as a non-extractable `CryptoKey` in IndexedDB database
  `comffee-cctv`, store `keys`, keyed by keyId. On import it checks that the key really matches the
  file's keyId.
- Key rotation: `PUT /api/keys/vault` with a new key makes it active. Old keys stay listed, so older
  files can still be opened with their recovery files.
- Recording stays off until a vault key exists.

## 12. Camera detection and adding

Detection result items: `{ip (real LAN IP), rtspPort | null, onvifPort | null, rtsp, onvif,
guessVendor: 'tapo' | 'onvif' | 'custom' | null, alreadyAdded}`.

Probes:

- TCP connect to ports 554 and 2020 (800 ms timeout, 32 at a time).
- RTSP: `OPTIONS rtsp://ip:554/ RTSP/1.0` with a CSeq, expecting a reply starting `RTSP/1.0`.
- ONVIF: unauthenticated `GetSystemDateAndTime` POST to `http://ip:2020/onvif/device_service`.
- Tapo guess: ONVIF on 2020 plus RTSP on 554.

Adding a camera with credentials: ONVIF `GetDeviceInformation` with a WS-Security UsernameToken
PasswordDigest reads the manufacturer and model; ffprobe (8 second timeout, `-rtsp_transport tcp`)
tests the main and sub paths. Tapo defaults: main `/stream1`, sub `/stream2`.

Saved camera login: `PATCH /api/locations/:id {cameraUsername, cameraPassword}` (both together, 1 to
128 characters each) saves one login per location; `{clearCameraLogin: true}` removes it. The owner
sees `cameraUsername`; everyone sees `hasCameraLogin`; the password is never returned or logged.
`POST /api/cameras` and `POST /api/cameras/test` use it when the body has neither `username` nor
`password` (422 "Save a camera login for this location first" when none is saved). The camera stores
its own sealed copy, so later changes to the saved login do not change cameras already added, and
`POST /api/cameras/:id/test` keeps using the camera's own login.

Adding found cameras: `POST /api/locations/:id/cameras/add-detected` (owner only) takes up to 254
devices from a detection. Each address must be a private IPv4 inside the location's camera network
(router and direct) or any RFC 1918 address (bridge), with the connector's allowed ports; one bad
entry rejects the whole list. Addresses already in the location are skipped and reported. Vendor is
the request's, else `onvif` when an ONVIF port is given, else `custom`; only Tapo has known stream
paths (`/stream1`, `/stream2`), so other cameras are reported as "add by hand". Each remaining camera
is stream-tested with the saved login (ffprobe, at most 3 at a time, each test counts against the 30
tests an hour); only cameras whose streams open are added, named "Camera N" with the lowest free
numbers in that location, and each add is audited as `camera.create`.

## 13. Router script (RouterOS 7)

Generated per router location. Every item carries `comment="comffee-cctv"`.

1. WireGuard interface `wg-cctv` (the router makes its own key).
2. Peer: the hub public key, endpoint `config.publicIp` port 51820, allowed-address `10.77.0.1/32`,
   persistent-keepalive 25s.
3. IP address `10.77.S.2/16` on `wg-cctv`.
4. dstnat: `in-interface=wg-cctv dst-address=10.78.S.0/24 action=netmap to-addresses=<camera subnet>`.
5. Filter forward: accept `in-interface=wg-cctv` to the camera subnet on TCP 554 and 2020, then drop
   `in-interface=wg-cctv`.
6. Filter input: drop `in-interface=wg-cctv`, placed at the top (safely, also when the chain is empty).
7. Simple queue `target=wg-cctv max-limit=<cap>k/<cap>k priority=8/8`.
8. Optional mangle output: `udp dst-address=<hub IP> dst-port=51820 mark-routing=<table> passthrough=no`.
9. The last line prints the router's `wg-cctv` public key, which the owner pastes into the location page
   (saved with `PATCH /api/locations/:id {routerPublicKey}`).

The undo script removes every item with that comment. A generic WireGuard config is also offered for
other routers, with a plain note that the router must map `10.78.S.0/24` to the camera subnet, or else
the bridge should be used.

## 14. Dashboard

Preact + Vite + TypeScript PWA, served by the hub from `dashboard/dist` with SPA fallback. The service
worker caches only the app shell, never `/api`, `/live` or recordings.

Design follows the Comffee web design rules: SAP Fiori type in the 72 font, Comffee colours (espresso
ground, cream text, mocha labels, amber accent). See `docs/DESIGN-SPEC.md`.

Routes: `/setup`, `/login`, `/live` (default after login), `/recordings`, `/cameras`, `/cameras/add`,
`/locations`, `/locations/new`, `/locations/:id`, `/settings`, `/settings/account`, `/settings/users`,
`/settings/audit`, `/settings/storage`, `/settings/recovery-key`, `/settings/recovery-key/new`.

Viewer navigation: Live, Recordings, Settings (account and recovery key only).

During development `vite dashboard` proxies `/api` and `/bridge` to the hub on `127.0.0.1:8080`, and
`/live` to MediaMTX WebRTC on `127.0.0.1:8889` with the prefix stripped, as Caddy does in production.

## 15. Deployment

`deploy/install.sh` on Ubuntu 24.04:

- Installs ffmpeg, wireguard-tools, Caddy (official signed apt repository), Node 24 (official tarball
  verified against SHASUMS256) and MediaMTX (pinned, verified against its release checksums).
- Creates the system user `comffee-cctv`; code in `/opt/comffee-cctv`, config in
  `/etc/comffee-cctv/hub.json`, data in `dataDir`.
- Sets up `wg0` with a generated hub key.
- iptables: allow 22, 80 and 443/tcp, 51820/udp and 8189/udp; on `wg0` inbound only established and
  related; rules persisted. The rules live in the chain `COMFFEE-CCTV-IN`, whose jump is kept as the
  first INPUT rule, in front of the REJECT that Oracle's Ubuntu images end INPUT with.
- systemd units `comffee-cctv-mediamtx` and `comffee-cctv-hub`. The hub unit has
  `AmbientCapabilities=CAP_NET_ADMIN` only (to run `wg` and `ip`), `NoNewPrivileges`,
  `ProtectSystem=strict`, `ReadWritePaths` for dataDir, `PrivateTmp`, `ProtectHome` and `TZ=UTC`.
- Caddy: TLS for `--host` (a domain, or `<public-ip-with-dashes>.sslip.io` by default), HSTS, the
  `/live` routes from section 8, everything else to `127.0.0.1:8080`.
- Ends by printing the dashboard URL and a setup code. With `--setup-code <code>` it registers that
  code (never printed) right after writing the config, before the services start, and the install
  fails if that does not work.
- `--from-git <https url> [--ref <tag or branch>]` clones the code into a temporary folder first and
  then installs from it as usual (the copy in `/opt/comffee-cctv` keeps its git history for
  `update.sh`). `--host auto` means the default address.
- Runs without questions, so it also works unattended.

Unattended install: `deploy/cloud-init.yaml.template` is a `#cloud-config` file the desktop app renders
(placeholders `{{REPO_URL}}`, `{{REPO_REF}}`, `{{SETUP_CODE}}`) and passes as the new server's user data.
On first boot it installs git, clones the code into `/opt/comffee-cctv` at that version and runs
`install.sh --host auto --setup-code <code>`, logging to `/var/log/comffee-cctv-install.log` (root
only). The values reach the shell as arguments, never as script text. The clone runs without
credentials (`GIT_TERMINAL_PROMPT=0`), so the repo must be public; a failed clone or install ends the
log with `Comffee CCTV install FAILED <time>` and the reason. Target: Oracle's Ubuntu 24.04
aarch64 image with its default iptables rules.

On Oracle Cloud the same ports must also be opened in the VCN security list.
