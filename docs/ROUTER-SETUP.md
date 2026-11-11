# Connect a shop to the hub

Each location (shop or branch) needs a way for the hub to reach its cameras. Choose one when you add
the location in the dashboard:

| Connection | You need | Anything stored at the shop? |
|---|---|---|
| **Router** (recommended) | A MikroTik router with RouterOS 7, or another router that can do WireGuard plus a one-to-one network mapping | No |
| **Bridge** | Any always-on device at the shop that can run the bridge program | No video is ever saved on it |
| **Direct** | The hub on the same network as the cameras (testing, or a hub at the shop) | Not applicable |

Before you start, make sure the cameras have fixed addresses (a DHCP reservation in the router is
easiest), so they keep the same address after a power cut.

## MikroTik router (RouterOS 7)

### What the script does

- Makes an encrypted WireGuard tunnel from your router **out** to the hub. It works behind an ISP
  modem and shared (CGNAT) internet; nothing needs to be opened at the shop.
- Lets the hub reach **only the camera network, only on the camera ports** (554 for video, 2020 for
  ONVIF). Everything else coming through the tunnel is blocked, including the router itself.
- Caps how much upload the cameras may use (5 Mbps by default) at the lowest priority, so customers
  are not slowed down.
- Optionally sends the tunnel over a chosen internet line if the router has more than one.
- Labels everything it adds with the comment `comffee-cctv`, so the undo script can remove exactly
  those items.

The camera network must be exactly a `/24` network, for example `192.168.88.0/24` (addresses
192.168.88.1 to 192.168.88.254). Check your router's DHCP or address settings if you are not sure.

### Paste the script

1. In the dashboard, open **Locations**, your location, and copy the **router script**.
2. Open your router in **Winbox** (or the WebFig page) and choose **New Terminal**.
3. Paste the whole script and press Enter. Wait until it finishes.
4. The last line it prints is the router's tunnel key (a long code ending in `=`). Copy it.
5. Paste that key into the **Router key** field on the location page and press **Link router**.

### Check that it works

- On the location page, the location shows as recently seen.
- In the router terminal, this shows a recent **last-handshake** (a few seconds or minutes ago):

  ```
  /interface wireguard peers print detail where comment="comffee-cctv"
  ```

- Press **Detect cameras** on the location page. Your cameras should appear.

If there is no handshake: check that UDP 51820 is open in the cloud firewall (see
[ORACLE-SETUP.md](ORACLE-SETUP.md)), and that the router has internet.

Ping from the router to the hub does not answer. That is expected: the hub only accepts replies to
connections it opened itself through the tunnel.

### Undo

On the same location page, copy the **undo script** and paste it into the router terminal. It
removes everything labelled `comffee-cctv` and nothing else.

If you changed the hub's address or made a new hub, run the undo script first, then paste the new
router script.

## Other routers

The location page also shows a plain **WireGuard configuration** for other routers. It only works if
your router can do both of these:

1. Run a WireGuard tunnel with that configuration.
2. Map the hub-side network `10.78.S.0/24` (the location page shows the exact numbers)
   one-to-one onto your camera network, and allow only ports 554 and 2020 to the cameras from the
   tunnel.

Most home and ISP routers cannot do the second part. If yours cannot, use the bridge.

## When to use the bridge

Use the bridge when:

- you cannot change the router (for example the ISP's own modem-router),
- the router is not a MikroTik with RouterOS 7 and cannot do the mapping above,
- the cameras are not on a single `/24` network.

The bridge is a small program that runs on any always-on device at the shop, such as the cafe's
server PC. It connects out to the hub with a location token (shown on the location page; you can
make a new one there at any time, which disconnects the old one). It only connects to cameras on
private addresses and camera ports, carries at most 32 streams at once, and never saves video.

If the bridge device is off, nothing is recorded at the hub until it is back on.
