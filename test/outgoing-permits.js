const tape = require('tape');
const crypto = require('crypto');
const SecretStack = require('secret-stack');
const run = require('promisify-tuple');
const path = require('path');
const os = require('os');
const rimraf = require('rimraf');
const ssbKeys = require('ssb-keys');
const sleep = require('util').promisify(setTimeout);

const createSsbServer = SecretStack({
  caps: {shs: crypto.randomBytes(32).toString('base64')},
})
  .use(require('ssb-db2'))
  .use(require('ssb-friends'))
  .use(require('../lib'));

const CONNECTION_TIMEOUT = 500; // ms

tape('alice cannot connect to bob, but allows bob to connect', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'));
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'));

  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    timeout: CONNECTION_TIMEOUT,
    keys: ssbKeys.generate(),
    friends: {
      hops: 2,
      hookAuth: false,
    },
    conn: {
      firewall: {
        rejectBlocked: true,
        rejectUnknown: true,
      },
    },
  });

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    timeout: CONNECTION_TIMEOUT,
    keys: ssbKeys.generate(),
    friends: {
      hops: 2,
      hookAuth: false,
    },
    conn: {
      firewall: {
        rejectBlocked: true,
        rejectUnknown: true,
      },
    },
  });
  const [err] = await run(alice.connect)(bob.getAddress());
  t.match(err.message, /server hung up/, 'alice cannot connect');

  await sleep(1000);

  const [err2, rpc] = await run(bob.connect)(alice.getAddress());
  t.error(err2, 'no error');
  t.ok(rpc, 'bob connected to alice');

  await Promise.all([run(alice.close)(true), run(bob.close)(true)]);
  t.end();
});
