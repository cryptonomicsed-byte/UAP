import test from 'node:test';
import assert from 'node:assert/strict';
import { localVncTarget } from '../server/src/lib/local-vnc.ts';

test('local computer VNC stays on this host', () => {
  assert.deepEqual(localVncTarget('default'), { host: '127.0.0.1', port: 5999 });
  assert.deepEqual(localVncTarget('screen-101'), { host: '127.0.0.1', port: 6001 });
  assert.throws(() => localVncTarget('screen-nope'));
});
