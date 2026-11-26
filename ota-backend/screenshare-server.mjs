import { readFileSync } from 'node:fs';
import { start } from './server.mjs';
import { port } from './version.mjs';

const { lease, preview } = JSON.parse(readFileSync(0, 'utf8'));
if (!/^[0-9a-f]{64}$/.test(lease) || typeof preview !== 'boolean') throw new Error('Invalid Release reader connection');

async function gitcodeFetch(url, options) {
  const target = new URL(url);
  if (target.origin !== 'https://api.gitcode.com') return fetch(target, options);
  const headers = new Headers(options.headers);
  headers.set('authorization', `Bearer ${lease}`);
  return fetch(`http://127.0.0.1:48123${target.pathname}${target.search}`, {
    ...options, headers, redirect: 'manual',
  });
}

start({
  gitcodeFetch,
  listenPort: preview ? 48124 : port,
  listenAddress: preview ? '127.0.0.1' : '0.0.0.0',
});
