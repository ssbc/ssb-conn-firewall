import {FeedId} from 'ssb-typescript';
import {plugin, muxrpc} from 'secret-stack-decorators';
import {
  Attempt,
  AttemptsOpts,
  FirewallConfig,
  GraphEvent,
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
const Ref = require('ssb-ref');
const pull = require('pull-stream');
const pullPromise = require('pull-promise');
const cat = require('pull-cat');
const debug = require('debug')('ssb:conn-firewall');

const INCOMING_ATTEMPTS_FILENAME = 'conn-attempts.json';
const MAX_INCOMING_ATTEMPTS = 20;
const INCOMING_ATTEMPT_RECENTLY = 60 * 60e3; // 1 hour
const OUTGOING_FORGET_POLL = 1 * 60e3; // 1 minute
const OUTGOING_FORGET_THRESHOLD = 5 * 60e3; // 5 minutes

@plugin('0.1.0')
class ConnFirewall {
  private readonly ssb: SSBWithFriends;
  private readonly config: FirewallConfig;
  private readonly incomingAttemptsMap: Map<FeedId, number>;
  private readonly incomingAttemptsMapLoaded: Promise<void>;
  private readonly incomingAttemptsFilepath: string;
  private readonly outgoingAttemptsMap: Map<FeedId, number>;
  private timerForgetOutgoing: NodeJS.Timeout | null;
  private readonly notifyIncomingAttempts: any;

  constructor(ssb: SSB, cfg: SSBConfig) {
    if (!ssb?.friends?.graphStream) {
      throw new Error('ssb-conn-firewall expects ssb-friends to be installed');
    }
    this.ssb = ssb as SSBWithFriends;
    this.config = ConnFirewall.applyDefaults(cfg);
    this.incomingAttemptsMap = new Map();
    this.incomingAttemptsFilepath = path.join(
      cfg.path,
      INCOMING_ATTEMPTS_FILENAME,
    );
    this.incomingAttemptsMapLoaded = this.loadOldIncomingAttempts();
    this.notifyIncomingAttempts = Notify();
    this.outgoingAttemptsMap = new Map();
    this.timerForgetOutgoing = null;
    this.init();
  }

  static applyDefaults(cfg: SSBConfig): FirewallConfig {
    const output = {...cfg};
    output.conn ??= {};
    output.conn.firewall ??= {};
    output.conn.firewall.rejectBlocked ??= true;
    output.conn.firewall.rejectUnknown ??= false;
    return output.conn!.firewall! as FirewallConfig;
  }

  static pruneAttemptsEntries(
    map: typeof ConnFirewall.prototype.incomingAttemptsMap,
  ): Array<[FeedId, number]> {
    return [...map.entries()] // convert map to entries
      .sort((a, b) => b[1] - a[1]) // sort by descending timestamp order
      .slice(0, MAX_INCOMING_ATTEMPTS); // pick the top N
  }

  static prepareAttemptsData(
    map: typeof ConnFirewall.prototype.incomingAttemptsMap,
  ): Array<Attempt> {
    return ConnFirewall.pruneAttemptsEntries(map).map(([id, ts]) => ({id, ts}));
  }

  private async loadOldIncomingAttempts() {
    const filename = this.incomingAttemptsFilepath;
    if (!fs.existsSync(filename)) {
      return;
    }
    const [err, data] = await run(atomic.readFile)(filename, 'utf8');
    if (err) {
      console.error('failed to load ssb-conn-firewall attempts file: ' + err);
      return;
    }
    let entries = [] as Array<[FeedId, number]>;
    try {
      entries = JSON.parse(data.toString());
    } catch (err) {
      console.error('failed to parse ssb-conn-firewall attempts file: ' + err);
      return;
    }
    // Success:
    for (const [id, ts] of entries) {
      this.incomingAttemptsMap.set(id, ts);
    }
  }

  private async saveOldIncomingAttempts() {
    const filename = this.incomingAttemptsFilepath;
    const prunedAttempts = ConnFirewall.pruneAttemptsEntries(
      this.incomingAttemptsMap,
    );
    const json = JSON.stringify(prunedAttempts);
    const [err] = await run(atomic.writeFile)(filename, json, 'utf8');
    if (err) {
      console.error('failed to write ssb-conn-firewall attempts file: ' + err);
    }
  }

  private scheduleForgetOutgoing() {
    if (this.timerForgetOutgoing) return;

    this.timerForgetOutgoing = setInterval(() => {
      if (this.outgoingAttemptsMap.size === 0) {
        clearInterval(this.timerForgetOutgoing!);
        this.timerForgetOutgoing = null;
      }
      // Forget outgoing connectable feedIds that were attempted too long ago
      const now = Date.now();
      for (const [id, ts] of this.outgoingAttemptsMap) {
        if (now - ts > OUTGOING_FORGET_THRESHOLD) {
          this.outgoingAttemptsMap.delete(id);
        }
      }
    }, OUTGOING_FORGET_POLL);
    this.timerForgetOutgoing?.unref?.();
  }

  private monitorSocialGraphChanges() {
    const {ssb, config} = this;
    pull(
      ssb.friends.graphStream({live: true, old: false}),
      pull.drain((graph: GraphEvent) => {
        for (const source of Object.keys(graph)) {
          for (const dest of Object.keys(graph[source])) {
            const value = graph[source][dest];
            // Immediately disconnect from unauthorized peers who were connected
            if (
              (config.rejectBlocked &&
                source === ssb.id &&
                value === -1 &&
                ssb.peers[dest]) ||
              (config.rejectUnknown &&
                source === ssb.id &&
                value < -1 &&
                ssb.peers[dest])
            ) {
              ssb.peers[dest].forEach((rpc) => rpc.close(true));
              ssb.peers[dest] = [];
            }

            // If we are following or blocking a peer, delete their attempt logs
            if (
              config.rejectUnknown &&
              source === ssb.id &&
              (value >= 0 || value === -1)
            ) {
              this.incomingAttemptsMap.delete(dest);
              this.outgoingAttemptsMap.delete(dest);
              this.saveOldIncomingAttempts();
            }
          }
        }
      }),
    );
  }

  private monitorOutgoingConnections() {
    const firewall = this;
    const {ssb} = firewall;

    ssb.connect.hook(function (this: any, fn: Function, args: any[]) {
      const [msaddr, _cb] = args;
      const feedId = Ref.getKeyFromAddress(msaddr);
      firewall.outgoingAttemptsMap.set(feedId, Date.now()); // remember them
      firewall.scheduleForgetOutgoing(); // schedule to forget them later
      fn.apply(this, args);
    });
  }

  private monitorIncomingConnections() {
    const firewall = this;
    const {ssb, config} = firewall;

    // Patch ssb.auth to guard incoming connections
    ssb.auth.hook(async function (this: any, fn: Function, args: any[]) {
      const source = ssb.id;
      const [dest, cb] = args;

      // Blocked peers cannot connect to us
      if (config.rejectBlocked) {
        const [, blocked] = await run(ssb.friends.isBlocking)({source, dest});
        if (blocked) {
          debug('prevented blocked peer %s from connecting to us', dest);
          cb(new Error('client is blocked'));
          return;
        }
      }

      // Peers beyond our hops range cannot connect, but we'll log the attempt
      if (config.rejectUnknown) {
        // Unless we recently wanted to connect to them
        if (firewall.outgoingAttemptsMap.has(dest)) {
          fn.apply(this, args);
          return;
        }
        const [, hops] = await run(ssb.friends.hops)({});
        if (hops && (hops[dest] == null || hops[dest] < -1)) {
          debug('prevented unknown peer %s from connecting to us', dest);
          cb(new Error('client is a stranger'));
          const ts = Date.now();
          const previousTS = firewall.incomingAttemptsMap.get(dest) ?? 0;
          firewall.incomingAttemptsMap.set(dest, ts);
          if (previousTS + INCOMING_ATTEMPT_RECENTLY < ts) {
            firewall.notifyIncomingAttempts({id: dest, ts} as Attempt);
          }
          firewall.saveOldIncomingAttempts();
          return;
        }
      }

      // Happy case: allow connection
      fn.apply(this, args);
    });
  }

  private init() {
    this.monitorSocialGraphChanges();
    this.monitorOutgoingConnections();
    this.monitorIncomingConnections();
    this.debugInit();
  }

  private debugInit() {
    if (!debug.enabled) return;
    const names = [];
    if (this.config.rejectBlocked) names.push('blocked peers');
    if (this.config.rejectUnknown) names.push('unknown peers');
    if (names.length === 0) return;

    debug('configured to reject ' + names.join(' and '));
  }

  private oldIncomingAttempts() {
    return pull(
      pullPromise.source(this.incomingAttemptsMapLoaded),
      pull.map(() =>
        ConnFirewall.prepareAttemptsData(this.incomingAttemptsMap),
      ),
      pull.flatten(),
    );
  }

  private liveIncomingAttempts() {
    return this.notifyIncomingAttempts.listen();
  }

  @muxrpc('source')
  public attempts = (opts?: AttemptsOpts) => {
    const old = opts?.old ?? false;
    const live = opts?.live ?? true;

    if (!old && !live) return pull.empty();
    if (old && !live) return this.oldIncomingAttempts();
    if (!old && live) return this.liveIncomingAttempts();
    if (old && live) {
      return cat([this.oldIncomingAttempts(), this.liveIncomingAttempts()]);
    }
  };

  @muxrpc('sync')
  public reconfigure = (conf?: Partial<FirewallConfig>) => {
    if (!conf) return;
    if (typeof conf.rejectBlocked !== 'undefined') {
      this.config.rejectBlocked = !!conf.rejectBlocked;
    }
    if (typeof conf.rejectUnknown !== 'undefined') {
      this.config.rejectUnknown = !!conf.rejectUnknown;
    }
  };
}

module.exports = ConnFirewall;
