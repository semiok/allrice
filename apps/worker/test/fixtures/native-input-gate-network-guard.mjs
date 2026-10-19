import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const key = Symbol.for('allrice.input-gate.networkAttempts');
globalThis[key] = 0;
const deny = () => {
  globalThis[key]++;
  throw Error('OFFLINE_INPUT_GATE_NETWORK_FORBIDDEN');
};
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.connect =
  net.createConnection =
  net.Socket.prototype.connect =
  tls.connect =
    deny;
syncBuiltinESMExports();
