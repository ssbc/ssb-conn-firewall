const tape = require('tape');
const crypto = require('crypto');
const SecretStack = require('secret-stack');
const run = require('promisify-tuple');
const path = require('path');
const os = require('os');
const pull = require('pull-stream');
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

rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
rimraf.sync(path.join(os.tmpdir(), 'server-carol'));

let alice, bob, carol;

tape('setup', (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'));
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

tape('carol is unknown to alice, only one attempt seen', (t) => {
  let count = 0

  pull(
    alice.connFirewall.attempts(),
    pull.drain(async (attempt) => {
      count++
      if (count > 1) t.fail('got a duplicate attempt event')
      await sleep(100);
      t.equals(attempt.id, carol.id, 'logged that carol attempted');
      t.true(typeof attempt.ts, "carol's attempt is timestamped");
      t.pass(`timestamp is ${attempt.ts}`);
      const now = Date.now();
      t.pass(`now is ${now}`);
      t.true(attempt.ts < now, 'happened in the past');
      t.true(now - 1000 < attempt.ts, 'happened less than 1s ago');

      setTimeout(() => {
        t.end()
      }, 1000)
    }),
  );

  carol.connect(alice.getAddress(), (err) => {
    t.match(err.message, /server hung up/, 'carol cannot connect');

    carol.connect(alice.getAddress(), (err) => {
      t.match(err.message, /server hung up/, 'carol cannot connect');
    });
  });
});

tape('teardown', async (t) => {
  await Promise.all([
    run(alice.close)(true),
    run(carol.close)(true),
  ]);
  t.end();
});
