# Running the hub

Everyday care for a Comffee CCTV hub. All commands run on the server after connecting with SSH (see
[ORACLE-SETUP.md](ORACLE-SETUP.md)).

Where things are:

| What | Where |
|---|---|
| Program | `/opt/comffee-cctv` |
| Settings | `/etc/comffee-cctv/hub.json` |
| Database, recordings, secrets | `/var/lib/comffee-cctv` |
| Hub tunnel key | `/etc/wireguard/wg0.conf` |
| Web front door (HTTPS) | `/etc/caddy/Caddyfile` |

## Backups

Back up the settings and secrets, not the recordings. Recordings are large, already encrypted, and
age out anyway.

What matters and why:

- `/var/lib/comffee-cctv/secrets/`: without `master.key`, saved camera passwords (also each
  location's saved camera login) and everyone's two-step codes cannot be read, so every camera must
  be added again and every person must set up two-step again.
- `/var/lib/comffee-cctv/db.sqlite`: accounts, locations, cameras and the list of recordings.
- `/etc/wireguard/wg0.conf`: the hub tunnel key. Without it, every router location must paste a new
  router script.
- `/etc/comffee-cctv/hub.json`: the settings.

Make a backup (recording pauses for a few seconds):

```
sudo systemctl stop comffee-cctv-hub comffee-cctv-mediamtx
sudo tar -C / --exclude=var/lib/comffee-cctv/vault --exclude=var/lib/comffee-cctv/raw \
  -czf ~/comffee-cctv-backup-$(date +%F).tar.gz \
  etc/comffee-cctv etc/wireguard/wg0.conf var/lib/comffee-cctv
sudo systemctl start comffee-cctv-mediamtx comffee-cctv-hub
sudo chown "$USER" ~/comffee-cctv-backup-*.tar.gz
```

Copy it to your own computer (run this on your computer, not the server):

```
scp -i <path to the key file> ubuntu@<public IP>:comffee-cctv-backup-*.tar.gz .
```

Then delete it from the server (`rm ~/comffee-cctv-backup-*.tar.gz`). **The backup contains secret
keys.** Keep it as safely as the recovery key.

Your **recovery file and passphrase** are not on the server at all. Back them up yourself; see
[PRIVACY.md](PRIVACY.md).

### Restore on a new server

1. Make the server and run the installer as usual.
2. Copy the backup to the new server, then:

   ```
   sudo systemctl stop comffee-cctv-hub comffee-cctv-mediamtx
   sudo tar -C / -xzf comffee-cctv-backup-<date>.tar.gz
   sudo chown -R comffee-cctv:comffee-cctv /var/lib/comffee-cctv
   sudo systemctl restart wg-quick@wg0
   sudo bash /opt/comffee-cctv/deploy/install.sh
   ```

The last step picks up the restored settings and the new server's address. If the public IP
changed, paste the router script again at each router location. Recordings from the old server are
still listed until they age out, but cannot be downloaded because their files were not in the backup.

## Updating

```
sudo bash /opt/comffee-cctv/deploy/update.sh
```

It fetches the newest version, checks the downloads again, rebuilds the dashboard and restarts.
Settings, keys and recordings are kept. Live view and recording pause for about a minute.

To go to a specific release: `sudo bash /opt/comffee-cctv/deploy/update.sh --ref <release tag>`.

## Rotating the recovery key

Make a new recovery key when the passphrase may be known to someone who should not have it (for
example a staff member who left), or a copy of the recovery file was lost.

1. In the dashboard, open **Settings**, **Recovery key**, and make a new key. Save the new file and
   passphrase in two safe places.
2. New recordings use the new key from then on.
3. **Keep the old recovery file and passphrase** until the last recording made with it has been
   deleted (the location's number of days after the switch). Older recordings still need the old
   key.

## Disk space

- In the dashboard: **Settings**, **Storage** shows how much space each location uses.
- On the server:

  ```
  df -h /var/lib/comffee-cctv
  sudo du -sh /var/lib/comffee-cctv/vault
  ```

The hub keeps at least 10% of the disk (and at least 5 GB) free. When free space drops below that,
it deletes the oldest recordings early and writes a "storage prune" line in the audit log. If that
happens often, lower the number of days, use a lower quality, or record fewer cameras.

## Logs and status

```
systemctl status comffee-cctv-hub comffee-cctv-mediamtx caddy
journalctl -u comffee-cctv-hub -f                      # hub, live (Ctrl+C to stop)
journalctl -u comffee-cctv-mediamtx --since "1 hour ago"   # media server
journalctl -u caddy --since today                      # HTTPS and certificates
sudo wg show                                           # router tunnels and their last handshake
sudo iptables -L COMFFEE-CCTV-IN -n -v                 # firewall rules and hit counts
sudo iptables -S INPUT | head -3                       # the first rule must be "-A INPUT -j COMFFEE-CCTV-IN"
```

Restart everything: `sudo systemctl restart comffee-cctv-mediamtx comffee-cctv-hub`.

## Other tasks

**New setup code** (only works while no owner account exists):

```
cd /opt/comffee-cctv && sudo runuser -u comffee-cctv -- env COMFFEE_CCTV_CONFIG=/etc/comffee-cctv/hub.json /usr/local/lib/comffee-cctv/node/bin/node server/src/main.ts setup-code
```

Add `--code <code>` at the end to use a code you made up instead (26 to 64 letters A to Z and digits
2 to 7). The hub stores only a fingerprint of it and does not print it, and that code stays valid for
30 days (a printed code lasts 24 hours). The desktop app and
`install.sh --setup-code <code>` use this.

**Install log of a server the desktop app made:** `sudo cat /var/log/comffee-cctv-install.log`.
It ends with "install finished" or "install FAILED" and the reason. "Could not download the code"
means the project address in the app's settings is not public or the version does not exist there.

**Bridge download link:** the bridge setup page shows a download button only when
`bridgeDownloadUrl` in `/etc/comffee-cctv/hub.json` is set to an `https://` page where you publish
the bridge program (for example your project's releases page). Set it, then run
`sudo systemctl restart comffee-cctv-hub`. The installer keeps the value.

**Saved camera logins:** each location can keep one camera username and password (set on the
location page). Cameras added without their own login, including cameras added straight from a
camera search, use it.
The password is stored encrypted with `master.key` and never shown again. Each camera keeps its own
copy, so changing or removing the saved login does not change cameras already added.

**The public IP changed, or you want your own domain:** run
`sudo bash /opt/comffee-cctv/deploy/install.sh` (add `--host cctv.yourdomain.com` for a domain). If the
IP changed, run the undo script and then the new router script at each router location.

**Remove Comffee CCTV:** `sudo bash /opt/comffee-cctv/deploy/uninstall.sh`. It asks before deleting the
tunnel key and before deleting recordings and settings.
