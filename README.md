# ssb-conn-firewall

secret-stack plugin to configure which incoming connections can occur. For use with the [SSB CONN](https://github.com/staltz/ssb-conn) family of modules. Spiritual successor to [ssb-incoming-guard](https://github.com/ssbc/ssb-incoming-guard).

## Installation

**Prerequisites:**

- Requires **Node.js 10** or higher
- Requires `secret-stack@6.2.0` or higher
- Requires `ssb-friends@5` or higher

```
npm install --save ssb-conn-firewall
```

Add this plugin to ssb-server like this:

```diff
 var createSsbServer = require('ssb-server')
     .use(require('ssb-onion'))
     .use(require('ssb-unix-socket'))
     .use(require('ssb-no-auth'))
     .use(require('ssb-master'))
     .use(require('ssb-db2'))
     .use(require('ssb-friends'))
     .use(require('ssb-conn'))
+    .use(require('ssb-conn-firewall'))
     // ...
```

## Usage

### Configuration

Some parameters can be configured by the user or by application code through the conventional [ssb-config](https://github.com/ssbc/ssb-config) object. The possible options are listed below:

```typescript
{
  conn: {
    firewall: {
      /**
       * Whether the firewall should forbid connections from peers that are
       * explicitly blocked by us (according to ssb-friends).
       *
       * Default is `true`.
       */
      rejectBlocked: boolean,

      /**
       * Whether the firewall should forbid connections from peers that are
       * unknown to us, i.e. not within our configured hops range (according to
       * ssb-friends).
       *
       * An exception to this rule is when we have recently tried to connect to
       * a stranger, then we allow them to connect to us.
       *
       * Default is `false`.
       */
      rejectUnknown: boolean
    }
  }
}
```

### muxrpc APIs

#### `ssb.connFirewall.attempts([opts]) => Source`

In case you have the `rejectUnknown` configuration enabled, `ssb-conn-firewall` allows you (as a developer) to see which connection attempts were made by strangers. These attempts are also persisted to disk in the file `~/.ssb/conn-attempts.json` and streamed via this API.

The `attempts([opts])` API returns a pull-stream of such connection attempts, where each attempt is expressed as an object `{id, ts}`, where `id` is the SSB ID of the peer who attempted to connect to us, and `ts` is a timestamp of when that attempt happened.

- `opts.old` _Boolean_ - whether or not to include previous attempts stored in disk. (Default: `false`)
- `opts.live` _Boolean_ - whether or not to include subsequent attempts happening during the execution of your program. (Default: `true`)

#### `ssb.connFirewall.reconfigure(config) => void`

At any point during the execution of your program, you can reconfigure the firewall rules using this API. The configuration object passed to this API has the same shape as `config.conn.firewall` (see above) has. Any subsequent attempts to connect will abide by the new rules.

## License

MIT
