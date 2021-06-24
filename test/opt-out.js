const tape = require('tape');
const crypto = require('crypto');
const SecretStack = require('secret-stack');
const run = require('promisify-tuple');
const path = require('path');
const os = require('os');
const pull = require('pull-stream');
const rimraf = require('rimraf');
const ssbKeys = require('ssb-keys');

const createSsbServer = SecretStack({
  caps: {shs: crypto.randomBytes(32).toString('base64')},
})
  .use(require('ssb-db2'))
  .use(require('ssb-friends'))
  .use(require('../lib'));

const CONNECTION_TIMEOUT = 500; // ms

rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
rimraf.sync(path.join(os.tmpdir(), 'server-bob'));
rimraf.sync(path.join(os.tmpdir(), 'server-carol'));

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
    conn: {
      firewall: {
        rejectBlocked: false,
        rejectUnknown: true,
      },
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

tape('alice blocks bob, but allows bob to connect', async (t) => {
  const [err] = await run(alice.db.publish)({
    type: 'contact',
    contact: bob.id,
    blocking: true,
  });
  t.error(err, 'published contact msg');

  const [err2, rpc] = await run(bob.connect)(alice.getAddress());
  t.error(err2, 'no error to connect');
  t.ok(rpc, 'rpc established');

  t.end();
});

tape('carol is unknown to alice, carol cannot connect to alice', async (t) => {
  t.plan(5);

  pull(
    alice.connFirewall.attempts(),
    pull.drain((attempt) => {
      t.equals(attempt.id, carol.id, 'logged that carol attempted');
      t.true(typeof attempt.ts, "carol's attempt is timestamped");
      t.true(attempt.ts < Date.now(), 'happened in the past');
      t.true(Date.now() - 1000 < attempt.ts, 'happened less than 1s ago');
    }),
  );

  const [err2] = await run(carol.connect)(alice.getAddress());
  t.match(err2.message, /server hung up/, 'bob cannot connect');
});

tape('teardown', async (t) => {
  await Promise.all([
    run(alice.close)(true),
    run(bob.close)(true),
    run(carol.close)(true),
  ]);
  t.end();
});
