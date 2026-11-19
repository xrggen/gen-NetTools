import { connect } from 'node:net';
import { port } from './version.mjs';

const connection = connect({ host: '127.0.0.1', port });
connection.setTimeout(3000);
connection.once('connect', () => connection.destroy());
connection.once('timeout', () => { process.exitCode = 1; connection.destroy(); });
connection.once('error', () => { process.exitCode = 1; });
