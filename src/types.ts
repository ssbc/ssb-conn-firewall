import {FeedId} from 'ssb-typescript';

export interface Callback<T = any> {
  (err?: any, x?: T): void;
}

export interface SSBConfig {
  path: string;
  conn?: {
    firewall?: {
      rejectBlocked?: boolean;
      rejectUnknown?: boolean;
    };
  };
}

type RequiredDeep<T> = {
  [P in keyof T]-?: RequiredDeep<T[P]>;
};

export type FirewallConfig = RequiredDeep<SSBConfig>['conn']['firewall']

export interface SSB {
  id: FeedId;
  keys: any;
  auth: CallableFunction & {
    hook: CallableFunction;
  };
  friends?: {
    graphStream: (opts: {old: boolean; live: boolean}) => CallableFunction;
    isBlocking: (
      opts: {source: FeedId; dest: FeedId},
      cb: Callback<boolean>,
    ) => void;
    hops: (opts: any, cb: Callback<any>) => void;
  };
  peers: Record<FeedId, Array<RPC>>;
}

export type SSBWithFriends = SSB & Required<Pick<SSB, 'friends'>>;

export interface RPC {
  close: CallableFunction;
}

export interface GraphEvent {
  [source: string]: {
    [dest: string]: number;
  }
}

export interface AttemptsOpts {
  old: boolean;
  live: boolean;
}

export interface Attempt {
  id: FeedId;
  ts: number;
}