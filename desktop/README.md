# Comffee CCTV for Windows

A Windows app that makes a free Oracle Cloud server for Comffee CCTV and then opens its dashboard.
Each installed app keeps its own list of Oracle accounts and servers, and an Oracle account can be
changed at any time in **Accounts**.

## Using the app

### First start

1. **Connect your Oracle account.** Pick one way:
   - **Sign in with Oracle** (recommended). Choose your home region (Singapore is first), press
     **Sign in with Oracle** and sign in on the Oracle page that opens in your browser. The app gets a
     sign-in that lasts about an hour and renews itself while the app is open, for at most 24 hours.
     No password and no permanent key is saved.
   - **Use an API key.** In Oracle Cloud open your profile, **API keys**, **Add API key**, choose
     **Download private key**, then **Add**. Paste the **Configuration file preview** text into the app
     and choose the downloaded `.pem` file.
2. **Create your free server.** The app shows what it will make before it starts:
   - a network `comffee-cctv-vcn` (10.0.0.0/16) with an internet gateway and a public subnet
     `comffee-cctv-subnet` (10.0.0.0/24),
   - firewall rules for TCP 22, 80, 443 and UDP 51820, 8189,
   - the server `comffee-cctv-hub`: Ampere A1, 4 cores and 24 GB memory, Ubuntu 24.04, 190 GB disk,
     a public address.

   Everything fits Oracle's Always Free plan. Things that already exist with these names are used
   again. If Oracle has no free servers left, the app says "Oracle is busy, still trying" and tries
   again every minute until you press **Cancel**; after a few tries it asks for 2 cores and 12 GB
   instead. It never makes a server when the account's free allowance is already used by others.
3. **Wait for the install** (about 10 minutes). The dashboard then opens with the setup code already
   filled in, and you create the owner account there.

Already have a server? Choose **Already have a server?** and paste its link. No Oracle account is
needed for that.

Oracle allows one free account per person.

### Every day

The window shows the selected server's dashboard. The bar at the top has the server switcher,
**Add server** and **Accounts**. In **Accounts** you can:

- add or remove Oracle accounts, sign in again, or **Change Oracle account**,
- rename a server or remove it from the app (this only signs the app out of it; the server, its
  cameras and recordings stay in the cloud),
- **Create another server** with a connected account,
- change the **Install source** (the git address and version new servers install).

## Security

- Every window runs sandboxed with context isolation and no Node. The server's dashboard runs with
  no preload at all, in its own storage per server.
- The dashboard can only move within its own server's address; other links open in your browser.
- All permission requests are refused except full screen (and writing to the clipboard from the
  dashboard's own Copy buttons).
- Certificate errors are never ignored.
- Oracle private keys, sign-in tokens, the app's SSH key and pending setup codes are stored only
  encrypted with Windows DPAPI (Electron safeStorage) in the app's data folder, and never logged.
- The app's own screens have a strict Content-Security-Policy, and only they can call the app.

The app's data folder is `%APPDATA%\Comffee CCTV`. Uninstalling keeps it; delete it to forget all
accounts and servers on this computer.

## Building

Requirements: Node 24 and the repository's dev dependencies (`npm install` at the repository root).

```
npm run dev:desktop      # build desktop/dist and start the app
npm run build:desktop    # build desktop/dist and make the Windows installer in desktop/release
npm run typecheck        # includes desktop/tsconfig.json and desktop/tsconfig.renderer.json
npm test                 # includes desktop/test
```

| Path | Contents |
| --- | --- |
| `src/main/` | Main process: windows, the `app://local` screens, IPC, accounts, server creation |
| `src/preload/` | Preload of the local screens (`window.cctv`) |
| `src/lib/` | Plain TypeScript, also run by the tests: request signing, Oracle client, rules, cloud-init |
| `renderer/` | Local screens (Preact), built by `vite.config.ts` with the dashboard's components and theme |
| `test/` | `node --test` tests |
| `build.mjs` | esbuild for main and preload, then Vite for the screens |
| `electron-builder.yml` | Windows NSIS installer (per user, folder can be changed, unsigned) |

`build.mjs` bakes `deploy/cloud-init.yaml.template` into the app; new servers install the code from
the **Install source** setting (default `https://github.com/comffeednp/comffee-cctv.git`, version
`main`).

"Sign in with Oracle" follows the OCI CLI's `oci session authenticate`: a listener on
`127.0.0.1:8181`, a fresh RSA key whose public JWK goes to
`https://login.<region>.oraclecloud.com/v1/oauth2/authorize`, the token handed back to the local page,
requests signed with key id `ST$<token>`, and renewal at
`https://auth.<region>.oraclecloud.com/v1/authentication/refresh`.
