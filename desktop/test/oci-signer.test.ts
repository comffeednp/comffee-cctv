// Request signing against the test vector of Oracle's "Request Signatures" documentation (the same key,
// requests and expected signatures the OCI SDKs test with, e.g. oci-go-sdk common/http_signer_test.go).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { sha256Base64, signRequest } from '../src/lib/oci-signer.ts';

const PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C36rPJj+CvfSC8+q28hxA161QF
NUd13wuCTUcq0Qd2qsBe/2hFyc2DCJJg0h1L78+6Z4UMR7EOcpfdUE9Hf3m/hs+F
UR45uBJeDK1HSFHD8bHKD6kv8FPGfJTotc+2xjJwoYi+1hqp1fIekaxsyQIDAQAB
AoGBAJR8ZkCUvx5kzv+utdl7T5MnordT1TvoXXJGXK7ZZ+UuvMNUCdN2QPc4sBiA
QWvLw1cSKt5DsKZ8UETpYPy8pPYnnDEz2dDYiaew9+xEpubyeW2oH4Zx71wqBtOK
kqwrXa/pzdpiucRRjk6vE6YY7EBBs/g7uanVpGibOVAEsqH1AkEA7DkjVH28WDUg
f1nqvfn2Kj6CT7nIcE3jGJsZZ7zlZmBmHFDONMLUrXR/Zm3pR5m0tCmBqa5RK95u
412jt1dPIwJBANJT3v8pnkth48bQo/fKel6uEYyboRtA5/uHuHkZ6FQF7OUkGogc
mSJluOdc5t6hI1VsLn0QZEjQZMEOWr+wKSMCQQCC4kXJEsHAve77oP6HtG/IiEn7
kpyUXRNvFsDE0czpJJBvL/aRFUJxuRK91jhjC68sA7NsKMGg5OXb5I5Jj36xAkEA
gIT7aFOYBFwGgQAQkWNKLvySgKbAZRTeLBacpHMuQdl1DfdntvAyqpAZ0lY0RKmW
G6aFKaqQfOXKCyWoUiVknQJAXrlgySFci/2ueKlIE1QqIiLSZ8V8OlpFLRnb1pzI
7U1yQXnTAEFYM560yJlzUpOb1V4cScGd365tiSMvxLOvTA==
-----END RSA PRIVATE KEY-----`;

const KEY_ID =
  'ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq/' +
  'ocid1.user.oc1..aaaaaaaat5nvwcna5j6aqzjcaty5eqbb6qt2jvpkanghtgdaqedqw3rynjq/' +
  '20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34';
const DATE = 'Thu, 05 Jan 2014 21:31:40 GMT';

const GET_URL =
  'https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances' +
  '?availabilityDomain=Pjwf%3A%20PHX-AD-1&' +
  'compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa' +
  '&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q';

const POST_URL = 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments';
const POST_BODY = `{
    "compartmentId": "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",
    "instanceId": "ocid1.instance.oc1.phx.abuw4ljrlsfiqw6vzzxb43vyypt4pkodawglp3wqxjqofakrwvou52gb6s5a",
    "volumeId": "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q"
}`;

const GET_SIGNATURE =
  'GBas7grhyrhSKHP6AVIj/h5/Vp8bd/peM79H9Wv8kjoaCivujVXlpbKLjMPe' +
  'DUhxkFIWtTtLBj3sUzaFj34XE6YZAHc9r2DmE4pMwOAy/kiITcZxa1oHPOeRheC0jP2dqbTll' +
  '8fmTZVwKZOKHYPtrLJIJQHJjNvxFWeHQjMaR7M=';
const POST_SIGNATURE =
  'Mje8vIDPlwIHmD/cTDwRxE7HaAvBg16JnVcsuqaNRim23fFPgQfLoOOxae6WqKb1uPjYEl0qIdazWaBy/Ml8DRhqlocMwoSXv0fbukP8J5N80LCmzT/FFBvIvTB91XuXI3hYfP9Zt1l7S6ieVadHUfqBedWH0itrtPJBgKmrWso=';

const key = createPrivateKey(PRIVATE_KEY);

test('GET: signing string, signature and Authorization header match the documented example', () => {
  const signed = signRequest({ method: 'GET', url: GET_URL, keyId: KEY_ID, privateKey: key, date: DATE });
  assert.equal(
    signed.signingString,
    'date: Thu, 05 Jan 2014 21:31:40 GMT\n' +
      '(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa&displayName=TeamXInstances&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q\n' +
      'host: iaas.us-phoenix-1.oraclecloud.com',
  );
  assert.equal(signed.signature, GET_SIGNATURE);
  assert.equal(
    signed.headers.authorization,
    `Signature version="1",headers="date (request-target) host",keyId="${KEY_ID}",algorithm="rsa-sha256",signature="${GET_SIGNATURE}"`,
  );
  assert.equal(signed.headers.host, 'iaas.us-phoenix-1.oraclecloud.com');
  assert.equal(signed.headers.date, DATE);
  assert.equal(signed.headers['content-length'], undefined);
  assert.equal(signed.headers['x-content-sha256'], undefined);
});

test('POST: body headers, signing string and signature match the documented example', () => {
  assert.equal(Buffer.byteLength(POST_BODY), 316);
  const signed = signRequest({ method: 'POST', url: POST_URL, keyId: KEY_ID, privateKey: key, date: DATE, body: POST_BODY });
  assert.equal(signed.headers['content-length'], '316');
  assert.equal(signed.headers['content-type'], 'application/json');
  assert.equal(signed.headers['x-content-sha256'], 'V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=');
  assert.equal(
    signed.signingString,
    'date: Thu, 05 Jan 2014 21:31:40 GMT\n' +
      '(request-target): post /20160918/volumeAttachments\n' +
      'host: iaas.us-phoenix-1.oraclecloud.com\n' +
      'content-length: 316\n' +
      'content-type: application/json\n' +
      'x-content-sha256: V9Z20UJTvkvpJ50flBzKE32+6m2zJjweHpDMX/U4Uy0=',
  );
  assert.equal(signed.signature, POST_SIGNATURE);
  assert.equal(
    signed.headers.authorization,
    `Signature version="1",headers="date (request-target) host content-length content-type x-content-sha256",keyId="${KEY_ID}",algorithm="rsa-sha256",signature="${POST_SIGNATURE}"`,
  );
});

test('PUT signs the body headers; DELETE does not', () => {
  const put = signRequest({ method: 'PUT', url: POST_URL, keyId: KEY_ID, privateKey: key, date: DATE, body: '{}' });
  assert.match(put.headers.authorization!, /headers="date \(request-target\) host content-length content-type x-content-sha256"/);
  assert.equal(put.headers['x-content-sha256'], sha256Base64('{}'));
  const del = signRequest({ method: 'DELETE', url: POST_URL, keyId: KEY_ID, privateKey: key, date: DATE });
  assert.match(del.headers.authorization!, /headers="date \(request-target\) host"/);
  assert.match(del.signingString, /^date: .*\n\(request-target\): delete \/20160918\/volumeAttachments\nhost: /);
});

test('an empty POST body still signs content-length 0 and the empty hash', () => {
  const signed = signRequest({ method: 'POST', url: POST_URL, keyId: KEY_ID, privateKey: key, date: DATE });
  assert.equal(signed.headers['content-length'], '0');
  assert.equal(signed.headers['x-content-sha256'], '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
});

test('a session token signs with keyId ST$<token>', () => {
  const signed = signRequest({ method: 'GET', url: GET_URL, keyId: 'ST$abc.def.ghi', privateKey: key, date: DATE });
  assert.match(signed.headers.authorization!, /keyId="ST\$abc\.def\.ghi"/);
  // Same request, same key: the signature does not depend on the key id.
  assert.equal(signed.signature, GET_SIGNATURE);
});
