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
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-friends'))
  .use(require('../lib'));

const CONNECTION_TIMEOUT = 500; // ms

tape('bob follows alice, and alice can connect to bob', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'));

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

  const [err] = await run(bob.db.publish)({
    type: 'contact',
    contact: alice.id,
    following: true,
  });
  t.error(err, 'published contact msg');

  await sleep(2000);

  const [err2, rpc] = await run(alice.connect)(bob.getAddress());
  t.error(err2, 'no error to connect');
  t.ok(rpc, 'alice connected to bob');

  await Promise.all([run(alice.close)(true), run(bob.close)(true)]);
  t.end();
});
