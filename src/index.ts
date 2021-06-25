import {FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {
  Attempt,
  AttemptsOpts,
  GraphEvent,
  RequiredDeep,
  SSB,
  SSBConfig,
  SSBWithFriends,
} from './types';
import run = require('promisify-tuple');
import fs = require('fs');
import path = require('path');
const atomic = require('atomic-file-rw') as Pick<
  typeof fs,
  'readFile' | 'writeFile'
>;
const Notify = require('pull-notify');
const pull = require('pull-stream');
const pullPromise = require('pull-promise');
const cat = require('pull-cat');
const debug = require('debug')('ssb:conn-firewall');

const ATTEMPTS_FILENAME = 'conn-attempts.json';
const MAX_ATTEMPTS = 20;

@plugin('0.1.0')
class ConnFirewall {
  private readonly ssb: SSBWithFriends;
  private readonly config: RequiredDeep<SSBConfig>;
  private attemptsMap: Map<FeedId, number> | null;
  private attemptsMapLoaded: Promise<
    NonNullable<typeof ConnFirewall.prototype.attemptsMap>
  >;
  private readonly attemptsFilepath: string;
  private readonly notifyAttempts: any;

  constructor(ssb: SSB, cfg: SSBConfig) {
    if (!ssb?.friends?.graphStream) {
      throw new Error('ssb-conn-firewall expects ssb-friends to be installed');
    }
    this.ssb = ssb as SSBWithFriends;
    this.config = ConnFirewall.applyDefaults(cfg);
    this.attemptsMap = null;
    this.attemptsFilepath = path.join(cfg.path, ATTEMPTS_FILENAME);
    this.attemptsMapLoaded = this.loadOldAttempts();
    this.notifyAttempts = Notify();
    this.init();
  }

  static applyDefaults(cfg: SSBConfig): RequiredDeep<SSBConfig> {
    const output = {...cfg};
    output.conn ??= {};
    output.conn.firewall ??= {};
    output.conn.firewall.rejectBlocked ??= true;
    output.conn.firewall.rejectUnknown ??= false;
    return output as RequiredDeep<SSBConfig>;
  }

  static pruneAttemptsEntries(
    map: NonNullable<typeof ConnFirewall.prototype.attemptsMap>,
  ): Array<[FeedId, number]> {
    return [...map.entries()] // convert map to entries
      .sort((a, b) => b[1] - a[1]) // sort by descending timestamp order
      .slice(0, MAX_ATTEMPTS); // pick the top N
  }

  static prepareAttemptsData(
    map: NonNullable<typeof ConnFirewall.prototype.attemptsMap>,
  ): Array<Attempt> {
    return ConnFirewall.pruneAttemptsEntries(map).map(([id, ts]) => ({id, ts}));
  }

  async loadOldAttempts() {
    const filename = this.attemptsFilepath;
    if (!fs.existsSync(filename)) {
      return (this.attemptsMap = new Map());
    }
    const [err, data] = await run(atomic.readFile)(filename, 'utf8');
    if (err) {
      console.error('failed to load ssb-conn-firewall attempts file: ' + err);
      return (this.attemptsMap = new Map());
    }
    let entries = [];
    try {
      entries = JSON.parse(data.toString());
    } catch (err) {
      console.error('failed to parse ssb-conn-firewall attempts file: ' + err);
      return (this.attemptsMap = new Map());
    }
    return (this.attemptsMap = new Map(entries));
  }

  async saveOldAttempts() {
    if (!this.attemptsMap) return;
    const filename = this.attemptsFilepath;
    const prunedAttempts = ConnFirewall.pruneAttemptsEntries(this.attemptsMap);
    const json = JSON.stringify(prunedAttempts);
    const [err] = await run(atomic.writeFile)(filename, json, 'utf8');
    if (err) {
      console.error('failed to write ssb-conn-firewall attempts file: ' + err);
    }
  }

  init() {
    const firewall = this;
    const {ssb, config, notifyAttempts} = firewall;

    // Whenever the social graph changes:
    pull(
      ssb.friends.graphStream({live: true, old: false}),
      pull.drain((graph: GraphEvent) => {
        for (const source of Object.keys(graph)) {
          for (const dest of Object.keys(graph[source])) {
            const value = graph[source][dest];
            // Immediately disconnect from unauthorized peers who were connected
            if (
              (config.conn.firewall.rejectBlocked &&
                source === ssb.id &&
                value === -1 &&
                ssb.peers[dest]) ||
              (config.conn.firewall.rejectUnknown &&
                source === ssb.id &&
                value < -1 &&
                ssb.peers[dest])
            ) {
              ssb.peers[dest].forEach((rpc) => rpc.close(true));
              ssb.peers[dest] = [];
            }

            // If we are following or blocking a peer, delete their attempt logs
            if (
              config.conn.firewall.rejectUnknown &&
              source === ssb.id &&
              (value >= 0 || value === -1)
            ) {
              this.attemptsMap?.delete(dest);
              this.saveOldAttempts();
            }
          }
        }
      }),
    );

    // Patch ssb.auth to guard incoming connections
    ssb.auth.hook(async function (this: any, fn: Function, args: any[]) {
      const source = ssb.id;
      const [dest, cb] = args;

      if (config.conn.firewall.rejectBlocked) {
        // Blocked peers also cannot connect to us
        const [, blocked] = await run(ssb.friends.isBlocking)({source, dest});
        if (blocked) {
          debug('prevented blocked peer %s from connecting to us', dest);
          cb(new Error('client is blocked'));
          return;
        }
      }

      if (config.conn.firewall.rejectUnknown) {
        // Peers beyond our hops range cannot connect, but we'll log the attempt
        const [, hops] = await run(ssb.friends.hops)({});
        if (hops && (hops[dest] == null || hops[dest] < -1)) {
          debug('prevented unknown peer %s from connecting to us', dest);
          cb(new Error('client is a stranger'));
          const ts = Date.now();
          firewall.attemptsMap?.set(dest, ts);
          notifyAttempts({id: dest, ts} as Attempt);
          firewall.saveOldAttempts();
          return;
        }
      }

      // Happy case: allow connection
      fn.apply(this, args);
    });

    this.debugInit();
  }

  private debugInit() {
    if (!debug.enabled) return;
    const names = [];
    if (this.config.conn.firewall.rejectBlocked) names.push('blocked peers');
    if (this.config.conn.firewall.rejectUnknown) names.push('unknown peers');
    if (names.length === 0) return;

    debug('configured to reject ' + names.join(' and '));
  }

  private oldAttempts() {
    return pull(
      pullPromise.source(this.attemptsMapLoaded),
      pull.map(() => ConnFirewall.prepareAttemptsData(this.attemptsMap!)),
      pull.flatten(),
    );
  }

  private liveAttempts() {
    return this.notifyAttempts.listen();
  }

  @muxrpc('source')
  public attempts = (opts?: AttemptsOpts) => {
    const old = opts?.old ?? false;
    const live = opts?.live ?? true;

    if (!old && !live) return pull.empty();
    if (old && !live) return this.oldAttempts();
    if (!old && live) return this.liveAttempts();
    if (old && live) return cat([this.oldAttempts(), this.liveAttempts()]);
  };
}

module.exports = ConnFirewall;
