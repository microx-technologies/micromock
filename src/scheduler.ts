import type { MockContext, Scheduler } from "@/types.ts";

interface ReadWatcher {
  resource: string;
  remaining: number;
  armed: boolean;
  fn: (ctx: MockContext) => void | Promise<void>;
}

export function createScheduler(getCtx: () => MockContext): Scheduler {
  const timers = new Set<NodeJS.Timeout>();
  const watchers = new Set<ReadWatcher>();

  return {
    after: (ms, fn) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error("micromock: after requires ms >= 0");
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        void fn(getCtx());
      }, ms);
      timers.add(timer);
      return () => {
        clearTimeout(timer);
        timers.delete(timer);
      };
    },

    afterReads: (resource, n, fn) => {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("micromock: afterReads requires n >= 1");
      }
      const watcher: ReadWatcher = { resource, remaining: n, armed: true, fn };
      watchers.add(watcher);
      return () => {
        watcher.armed = false;
        watchers.delete(watcher);
      };
    },

    countRead: (resource) => {
      for (const watcher of [...watchers]) {
        if (!watcher.armed || watcher.resource !== resource) continue;
        watcher.remaining--;
        if (watcher.remaining > 0) continue;
        watcher.armed = false;
        watchers.delete(watcher);
        void watcher.fn(getCtx());
      }
    },

    cancelAll: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) watcher.armed = false;
      watchers.clear();
    },
  };
}
