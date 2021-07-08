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
let alice, bob, carol;

tape('setup', (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'));
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'));

  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    timeout: CONNECTION_TIMEOUT,
    keys: ssbKeys.generate(),
    friends: {
      hops: 2,
      hookAuth: false,
    },
  });

  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    timeout: CONNECTION_TIMEOUT,
    keys: ssbKeys.generate(),
    friends: {
      hops: 2,
      hookAuth: false,
    },
  });

  carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    timeout: CONNECTION_TIMEOUT,
    keys: ssbKeys.generate(),
    friends: {
      hops: 2,
      hookAuth: false,
    },
  });

  t.end();
});

tape('alice blocks bob, and bob cannot connect to alice', async (t) => {
  const [err] = await run(alice.db.publish)({
    type: 'contact',
    contact: bob.id,
    blocking: true,
  });
  t.error(err, 'published contact msg');

  await sleep(2000);

  const [err2] = await run(bob.connect)(alice.getAddress());
  t.match(err2.message, /server hung up/, 'bob cannot connect');

  t.end();
});

tape('alice reconfigures to allow blocked (and thus bob)', async (t) => {
  const [err] = await run(alice.connFirewall.reconfigure)({
    rejectBlocked: false,
  });
  t.error(err, 'alice reconfigured her firewall');

  await sleep(2000);

  const [err2, rpc] = await run(bob.connect)(alice.getAddress());
  t.error(err2, 'no error to connect');
  t.ok(rpc, 'rpc established');

  t.end();
});

tape('carol is unknown to alice, carol can connect to alice', async (t) => {
  const [err, rpc] = await run(carol.connect)(alice.getAddress());
  t.error(err, 'no error to connect');
  t.ok(rpc, 'rpc established');

  t.end();
});

tape('teardown', async (t) => {
  await Promise.all([
    run(alice.close)(true),
    run(bob.close)(true),
    run(carol.close)(true),
  ]);
  t.end();
});
