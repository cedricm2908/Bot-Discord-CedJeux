import { FarmStore } from "./store";

let initPromise: Promise<FarmStore> | null = null;

export function getFarmStore(): Promise<FarmStore> {
  if (!initPromise) {
    initPromise = (async () => {
      const store = new FarmStore();
      await store.init();
      return store;
    })();
  }
  return initPromise;
}
