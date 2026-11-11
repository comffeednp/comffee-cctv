# Make a free Oracle Cloud server

This guide makes the cloud server ("hub") that records your cameras, using Oracle Cloud's Always
Free plan. Oracle's screens change from time to time, so a button may have a slightly different
name; the steps stay the same.

What the free plan gives you (enough for a few cameras):

- Ampere (ARM) processors: 4 cores and 24 GB of memory in total.
- 200 GB of disk in total.
- 10 TB of outgoing internet traffic a month. Incoming traffic (camera video) is free.

## 1. Sign up

1. Go to the Oracle Cloud Free Tier page and choose **Start for free**.
2. Fill in your details. Oracle asks for a card to check you are a real person. The Always Free
   plan does not charge it.
3. **Home region: choose Singapore** (closest to the Philippines). You cannot change the home region
   later, and free servers can only be made in the home region.
4. **Never choose "Upgrade" or "Pay As You Go" for this.** Everything here fits the free plan.

Oracle says it may reclaim Always Free servers that sit idle for a week (very low processor,
network and memory use). A hub that records cameras all day normally stays busy, but read any
email from Oracle about idle servers.

## The desktop app can do this for you

After step 1 (sign up), the Comffee CCTV desktop app can create the server and install the hub for
you, so you can skip steps 2, 3, 5 and 6. It makes the server with a short start-up script
(`deploy/cloud-init.yaml.template`) that installs everything on the server's first boot, with nobody
logged in, and gives you the one-time setup code. When it says the hub is ready, open the dashboard
address it shows and enter that code.

The server downloads the code from the project address in the app's settings without signing in,
so that project must be public on GitHub (or another git host) and the version must exist there.
If the app keeps saying the server is not answering, read the install log (see
[OPERATIONS.md](OPERATIONS.md)); a line with "install FAILED" says why.

The rest of this guide is the same job done by hand.

## 2. Create the server

In the Oracle Cloud console, open the menu, then **Compute**, **Instances**, **Create instance**.

1. **Name:** anything, for example `cctv-hub`.
2. **Image:** choose **Change image**, then **Ubuntu**, then **Canonical Ubuntu 24.04** (not the
   "Minimal" one). Oracle picks the ARM (aarch64) build for you in the next step.
3. **Shape:** choose **Change shape**, then **Ampere**, then **VM.Standard.A1.Flex**. Set
   **4 OCPUs** and **24 GB** memory. This uses the whole free ARM allowance.
4. **Networking:** let it create a new virtual cloud network and a **public subnet**, and keep
   **Assign a public IPv4 address** turned on.
5. **SSH keys:** choose **Generate a key pair for me** and press **Save private key**. Keep this file
   safe. It is the only way into the server.
6. **Boot volume:** turn on **Specify a custom boot volume size** and enter **190** GB.
7. Press **Create**. After a minute or two the server shows **Running** and a **Public IP address**.
   Write that address down.

### "Out of capacity"

Free ARM servers are popular and the region is sometimes full. If you see "Out of capacity":

- Try again later. Early morning and late night often work.
- If the form lets you choose between availability domains, try each one.
- Make it smaller first (for example 2 OCPUs and 12 GB), then later, when there is room, use
  **Edit**, **Shape** on the server to raise it to 4 OCPUs and 24 GB.
- Do not upgrade your account to get room.

The tiny free AMD server (1 GB of memory) is not enough for the hub.

## 3. Open the ports in Oracle's firewall

Oracle has its own firewall in front of the server (the "security list"). The installer handles
the firewall inside the server, but these must be opened here too.

1. On the server's page, open its **virtual cloud network**, then the **public subnet**, then its
   **Default Security List** (under **Security**).
2. Choose **Add Ingress Rules** and add four rules, each with **Source CIDR** `0.0.0.0/0`:

   | IP protocol | Destination port | What it is for |
   |---|---|---|
   | TCP | 80 | HTTPS certificate checks and redirect to HTTPS |
   | TCP | 443 | The dashboard |
   | UDP | 51820 | Router tunnels (WireGuard) |
   | UDP | 8189 | Live video |

Port 22 (SSH) is already open by default. Leave it.

Oracle's Ubuntu servers also come with firewall rules inside the server that refuse everything
except SSH. The installer puts its own rules in front of those, so you do not need to change them.

## 4. Optional: your own web address

Without a domain, the dashboard address will be your public IP with dashes plus `.sslip.io`, for
example `https://203-0-113-10.sslip.io`. That works and gets a real HTTPS certificate.

To use your own name instead, add an **A record** for it (for example `cctv.yourdomain.com`)
pointing at the server's public IP in your domain's DNS settings, and wait until it works before
installing.

## 5. Connect to the server

On Windows, open **PowerShell**. On a Mac or Linux, open **Terminal** and first run
`chmod 600 <path to the key file>`. Then:

```
ssh -i <path to the key file> ubuntu@<public IP>
```

Type `yes` the first time. You are now on the server.

## 6. Install Comffee CCTV

Use the project's own address from the green "Code" button on its GitHub page in place of
`<project address>`:

```
sudo apt-get update && sudo apt-get install -y git
sudo git clone <project address> /opt/comffee-cctv
sudo bash /opt/comffee-cctv/deploy/install.sh
```

With your own domain, run the last line as
`sudo bash /opt/comffee-cctv/deploy/install.sh --host cctv.yourdomain.com`.

The installer takes 5 to 15 minutes. At the end it prints the dashboard address and a one-time setup
code. Open the address, enter the code and create the owner account. The first visit can take a
minute while the HTTPS certificate is issued.

If the page does not open, check the four rules in step 3 first.

### Without the clone step

The installer can also download the code itself. Download `deploy/install.sh` on its own, then:

```
sudo bash install.sh --from-git <project address> --ref <release tag>
```

`--ref` is optional (default: the main branch). The code ends up in `/opt/comffee-cctv` as usual,
so updates work the same way.

### Creating the server with a start-up script

`deploy/cloud-init.yaml.template` is the start-up script the desktop app uses. To use it yourself,
replace `{{REPO_URL}}` (the project address, which must be public), `{{REPO_REF}}` (a release tag or `main`) and
`{{SETUP_CODE}}` (a code you make up: 26 or more letters A to Z and digits 2 to 7), then paste it
under **Show advanced options**, **Management**, **Paste cloud-init script** when you create the
server in step 2. The install log is in `/var/log/comffee-cctv-install.log` on the server. When the
dashboard opens, enter your code on the setup page.

## Next

- Connect your shop: [ROUTER-SETUP.md](ROUTER-SETUP.md).
- Keep it running well: [OPERATIONS.md](OPERATIONS.md).
