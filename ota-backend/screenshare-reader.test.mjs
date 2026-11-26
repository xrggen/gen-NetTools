import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { test } from 'node:test';
import { createReader } from './screenshare-reader.mjs';

const release = '/api/v5/repos/u010019490/gen-NetTools/releases';
const lease = 'local-test-lease';
const auth = { authorization: `Bearer ${lease}` };

test('ScreenShare reader forwards only the approved GitCode release reads', async t => {
  const calls = [];
  const { server, stop } = createReader({
    lease, upstreamAccess: 'upstream-fixture',
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, method: options.method, headers: options.headers, redirect: options.redirect });
      return new Response(null, {
        status: 302, headers: { location: 'https://file-cdn.gitcode.com/release', 'x-not-forwarded': 'fixture' },
      });
    },
  });
  t.after(stop);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const [path, options] of [
    [`${release}/latest?type=latest`, {}],
    [`${release}/latest?type=latest`, { headers: auth, method: 'DELETE' }],
    [`${release}/latest?type=latest&type=latest`, { headers: auth }],
    [`${release}?page=51&per_page=20`, { headers: auth }],
    [`${release}/v0.1.2/attach_files/gen-NetTools-0.1.3-win-x64-setup.exe/download`, { headers: auth }],
    ['/api/v5/repos/another/repository/releases', { headers: auth }],
    [`${release}/../issues`, { headers: auth }],
  ]) assert.equal((await fetch(origin + path, options)).status, 403, path);
  assert.equal(calls.length, 0);

  for (const path of [
    `${release}/latest?type=latest`,
    `${release}?page=1&per_page=20`,
    `${release}/v0.1.2-b1`,
    `${release}/v0.1.2/attach_files/gen-NetTools-update.sig/download`,
    `${release}/v0.1.2/attach_files/gen-NetTools-0.1.2-win-x64-setup.exe/download`,
  ]) {
    const response = await fetch(origin + path, { headers: { ...auth, range: 'bytes=100-' }, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://file-cdn.gitcode.com/release');
    assert.equal(response.headers.get('x-not-forwarded'), null);
    const routed = calls.at(-1);
    assert.equal(routed.url, `https://api.gitcode.com${path}`);
    assert.equal(routed.method, 'GET');
    assert.equal(routed.redirect, 'manual');
    assert.equal(routed.headers['private-token'], 'upstream-fixture');
    assert.equal(routed.headers.authorization, undefined);
    assert.equal(routed.headers.range, 'bytes=100-');
  }

  const closed = once(server, 'close');
  assert.equal((await fetch(origin + '/stop', { method: 'POST', headers: auth })).status, 204);
  await closed;
});
