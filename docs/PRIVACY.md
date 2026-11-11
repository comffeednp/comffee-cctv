# Privacy

CCTV footage shows people, so it is personal information. In the Philippines that means the
**Data Privacy Act of 2012** (Republic Act No. 10173) applies, overseen by the **National Privacy
Commission (NPC)**. This page is general information to help you set up the system well. It is not
legal advice. Read the NPC's current guidance on CCTV at privacy.gov.ph, and ask a lawyer when in
doubt.

## Good practice for your business

**Tell people.** Put clear signs at every entrance, readable before people walk in, saying that CCTV
is in use, why (for example security and safety), and who to contact about it.

**Record only what you need.** Point cameras at doors, counters, and the shop floor. Never record in
toilets, changing areas, or other places where people expect privacy. Avoid pointing cameras at
neighbours' property or the public street beyond your door.

**No sound.** Recording people's conversations without their consent can break the Anti-Wiretapping
Law (Republic Act No. 4200). Turn off the microphone or audio recording in each camera's own app.
At 720p quality this system never keeps sound; at 360p and 1080p it keeps whatever the camera sends.

**Keep recordings only as long as needed.** The default is 20 days. You can choose 1 to 90 days per
location; older recordings are deleted automatically. Choose the shortest time that serves your
purpose.

**Limit who can watch.** Give staff viewer accounts only for the locations they need. Viewers
cannot change settings, see other locations, or see who else has access. Everyone must use a
two-step code. The audit log records who signed in, watched live video, and downloaded recordings.

**Answer requests.** A person can ask whether you have footage of them and ask for a copy. Before
sharing, protect other people who appear in it.

**If footage leaks,** the NPC's breach rules may require you to tell the NPC and the people affected
quickly (within 72 hours for serious breaches). Depending on your business you may also need a Data
Protection Officer and NPC registration; check privacy.gov.ph.

## What the encryption protects

**Stored recordings are locked with your recovery key.** When you set up the system, your browser
makes a recovery key. Only its public half is sent to the hub. Every recorded 5-minute piece is
encrypted with that public half before it is saved, and the hub cannot unlock it again. To play a
recording, your browser downloads the locked piece and opens it with the recovery key, which stays on
your devices.

This means:

- someone who copies the server's disk or a backup cannot watch the recordings;
- the cloud provider cannot watch stored recordings;
- a viewer can only play recordings on a device that has the recovery key imported.

Other protections: the router tunnel is encrypted (WireGuard), the bridge connection is encrypted
(HTTPS), live video to your browser is encrypted (WebRTC), and camera passwords and two-step secrets
are sealed in the database.

## Its honest limits

- **The hub sees live video.** It must, to record it. Whoever controls the server (the cloud provider,
  or anyone who breaks into it) could watch live video. Each 5-minute piece also sits unencrypted on
  the server for a few minutes until it is finished and locked.
- **Recording details are not secret:** which camera, when, and how large each piece is.
- **Stored recordings need the recovery key.** Anyone who has both your recovery file and its
  passphrase can open every recording made with that key. Keep them apart from each other and away
  from staff.
- **A lost recovery key cannot be replaced.** If you lose the recovery file or forget its
  passphrase, the recordings made with that key can never be opened, by you or by anyone else. Keep
  two copies of the file in safe places (for example a USB stick in a safe, and a password manager)
  and write the passphrase down somewhere safe.
- **A device with the recovery key imported can open recordings** while signed in. Use only your own
  devices and keep them locked. On a shared computer, clear the site's data after use.
- **The camera itself is outside this system.** A microSD card in the camera is not encrypted by
  Comffee CCTV and can be stolen with the camera. The camera maker's own app and cloud follow their
  own rules.
