import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  getDeviceInformationRequest,
  onvifDeviceInfo,
  onvifProbe,
  parseDeviceInformation,
  parseUtcDateTime,
  wsseCreated,
  wsseDigest,
} from '../../src/sites/onvif.ts';

test('WS-Security PasswordDigest matches the ONVIF programmer guide vector', () => {
  const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
  assert.equal(wsseDigest(nonce, '2010-09-16T07:50:45Z', 'userpassword'), 'tuOSpGlFlIXsozq4HFNeeGeFLEI=');
});

test('GetDeviceInformation envelope carries the escaped user name, digest, nonce and created time', () => {
  const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
  const xml = getDeviceInformationRequest('a<b&"c', 'userpassword', new Date('2010-09-16T07:50:45.123Z'), nonce);
  assert.match(xml, /<Username>a&lt;b&amp;&quot;c<\/Username>/);
  assert.match(xml, /#PasswordDigest">tuOSpGlFlIXsozq4HFNeeGeFLEI=<\/Password>/);
  assert.match(xml, />LKqI6G\/AikKCQrN0zqZFlg==<\/Nonce>/);
  assert.match(xml, />2010-09-16T07:50:45Z<\/Created>/);
  assert.match(xml, /<GetDeviceInformation xmlns="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"\/>/);
  assert.doesNotMatch(xml, /userpassword/);
  assert.equal(wsseCreated(new Date('2026-01-02T03:04:05.999Z')), '2026-01-02T03:04:05Z');
});

const DEVICE_INFO = `<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
 xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><SOAP-ENV:Body><tds:GetDeviceInformationResponse>
<tds:Manufacturer>TP-Link &amp; Co</tds:Manufacturer><tds:Model>Tapo C200</tds:Model><tds:FirmwareVersion>1.0</tds:FirmwareVersion>
</tds:GetDeviceInformationResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const DATE_TIME = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>
<tds:GetSystemDateAndTimeResponse xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:SystemDateAndTime>
<tt:LocalDateTime><tt:Time><tt:Hour>20</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time>
<tt:Date><tt:Year>2026</tt:Year><tt:Month>1</tt:Month><tt:Day>2</tt:Day></tt:Date></tt:LocalDateTime>
<tt:UTCDateTime><tt:Time><tt:Hour>12</tt:Hour><tt:Minute>30</tt:Minute><tt:Second>15</tt:Second></tt:Time>
<tt:Date><tt:Year>2026</tt:Year><tt:Month>1</tt:Month><tt:Day>2</tt:Day></tt:Date></tt:UTCDateTime>
</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></s:Body></s:Envelope>`;

test('device information and camera clock are parsed from responses', () => {
  assert.deepEqual(parseDeviceInformation(DEVICE_INFO), { manufacturer: 'TP-Link & Co', model: 'Tapo C200' });
  assert.equal(parseDeviceInformation('<Envelope><Fault/></Envelope>'), null);
  assert.equal(parseUtcDateTime(DATE_TIME)?.toISOString(), '2026-01-02T12:30:15.000Z');
  assert.equal(parseUtcDateTime('<x/>'), null);
});

test('onvifDeviceInfo signs with the camera clock and reads the answer', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push(body);
      res.setHeader('Content-Type', 'application/soap+xml');
      if (body.includes('GetSystemDateAndTime')) res.end(DATE_TIME);
      else if (body.includes('2026-01-02T12:30:15Z') && body.includes('<Username>admin</Username>')) res.end(DEVICE_INFO);
      else {
        res.statusCode = 400;
        res.end('<s:Envelope><s:Body><s:Fault/></s:Body></s:Envelope>');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const target = { host: '127.0.0.1', port, hostHeader: `192.168.1.20:2020` };
    assert.deepEqual(await onvifProbe(target), { onvif: true, utc: new Date('2026-01-02T12:30:15Z') });
    assert.deepEqual(await onvifDeviceInfo(target, 'admin', 'secret'), { manufacturer: 'TP-Link & Co', model: 'Tapo C200' });
    assert.equal(await onvifDeviceInfo(target, 'other', 'secret'), null);
    assert.ok(seen.every((b) => !b.includes('secret')), 'password never sent in clear');
  } finally {
    server.close();
  }
  assert.deepEqual(await onvifProbe({ host: '127.0.0.1', port, hostHeader: 'x' }, 300), { onvif: false, utc: null });
});
