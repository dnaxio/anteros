/**
 * @anteros/store/vue — Native Vue 3 reactive store
 *
 * Uses Vue's native reactivity (reactive, readonly, watch).
 * Persistence via localStorage, sessionStorage, or a custom adapter.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { createStore, useStore } from '@anteros/store/vue'
 *
 * const store = createStore({
 *   namespace: 'counter',
 *   state: { count: 0, firstName: '', lastName: '' },
 *   getters: {
 *     double: (state) => state.count * 2,
 *     fullName: (state) => `${state.firstName} ${state.lastName}`.trim(),
 *   },
 *   actions: {
 *     increment() { this.state.count++ },
 *     setFullName(first: string, last: string) {
 *       this.patch({ firstName: first, lastName: last })
 *     },
 *   },
 *   persist: true,
 * })
 *
 * const { state, snap, getters, actions, patch } = useStore(store)
 * </script>
 *
 * <template>
 *   <p>{{ snap.count }} — double: {{ getters.double }}</p>
 *   <p>Nom : {{ getters.fullName || 'Anonyme' }}</p>
 *   <button @click="actions.increment()">+1</button>
 * </template>
 * ```
 */

import {
  reactive,
  readonly,
  watch,
  computed,
  onScopeDispose,
  type DeepReadonly,
  type UnwrapNestedRefs,
  type WatchCallback,
  type WatchStopHandle,
  type ComputedRef,
} from "vue";

// ─── Storage ──────────────────────────────────────────────────

/** Minimal interface for a storage engine (localStorage, sessionStorage, custom). */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolves the storage adapter for a given environment. */
function resolveStorage(type: "local" | "session" | StorageAdapter): {
  adapter: StorageAdapter | null;
  label: string;
} {
  if (typeof type === "object") {
    return { adapter: type, label: "custom" };
  }

  // SSR / environments without window
  if (typeof globalThis === "undefined") {
    return { adapter: null, label: "none (SSR)" };
  }

  const win = globalThis as any;
  const storage = type === "session" ? win.sessionStorage : win.localStorage;
  return { adapter: storage, label: type };
}

/**
 * Optional global prefix applied to all storage keys.
 *
 * @example
 * ```ts
 * import { setStoragePrefix } from '@anteros/store/vue'
 * setStoragePrefix('myapp')
 * // final key: myapp:cart:items
 * const store = createStore({ namespace: 'cart', key: 'items', persist: true })
 * console.log(store.key) // "myapp:cart:items"
 * ```
 */
let _globalPrefix = "";

export function setStoragePrefix(prefix: string): void {
  _globalPrefix = prefix;
}

export function getStoragePrefix(): string {
  return _globalPrefix;
}

// ─── Types ───────────────────────────────────────────────────

/**
 * Extracts the return type of each function in a record.
 * Ex: { double: (s: any) => number } → { double: number }
 * An empty object `{}` (keyof = never) produces `{}`.
 */
type ReturnTypes<T extends Record<string, (...args: any[]) => any>> =
  keyof T extends never ? {} : { [K in keyof T]: ReturnType<T[K]> };

/**
 * `this` context available in actions.
 */
type ActionCtx<T extends object, G extends Record<string, (...args: any[]) => any>> = {
  state: UnwrapNestedRefs<T>;
  getters: ReturnTypes<G>;
  actions: Record<string, (...args: any[]) => any>;
  patch: (partial: Partial<T> | ((state: UnwrapNestedRefs<T>) => void)) => void;
};

// ─── StoreOptions (inference friendly) ────────────────────────

/**
 * Options for creating a store.
 *
 * The `getters` and `actions` fields use concrete (non-generic) types
 * so TypeScript can provide **contextual typing** on the function
 * parameters (`state` in getters, `this` in actions).
 */
export interface StoreOptions<T extends object> {
  /** Unique key for storage (default: namespace).
   * Ex: `'cart'` → final key `prefix:namespace:cart` */
  key?: string;
  /** Namespace to isolate storage (default: `'default'`).
   * Also used as the default key if `key` is not provided. */
  namespace?: string;
  /** Initial store state */
  state: T;
  /** Getters: functions derived from state (reactive via computed) */
  getters?: Record<string, (state: T) => any>;
  /** Actions: mutating methods */
  actions?: Record<
    string,
    (this: ActionCtx<T, Record<string, (...args: any[]) => any>>, ...args: any[]) => any
  >;
  /**
   * Persist the state to storage.
   * - `true` → localStorage
   * - `'session'` → sessionStorage
   * - `StorageAdapter` → custom engine
   * - `false` → no persistence (default)
   */
  persist?: boolean | "session" | StorageAdapter;
}

/** Extracts the exact type of the getters of an options object. */
type ExtractGetters<O extends StoreOptions<any>> =
  O extends { getters: infer G } ? G : {};

/** Extracts the exact type of the actions of an options object. */
type ExtractActions<O extends StoreOptions<any>> =
  O extends { actions: infer A } ? A : {};

/**
 * Callback for store events
 */
type StoreCallback<T extends object> = (
  state: UnwrapNestedRefs<T>,
  oldValue: UnwrapNestedRefs<T>
) => void;

/**
 * Event registered in the store
 */
interface StoreEvent<T extends object> {
  event: string;
  callback: StoreCallback<T>;
}

// ─── Store ───────────────────────────────────────────────────

/**
 * Native Vue 3 reactive store
 *
 * @example
 * ```ts
 * const store = createStore({
 *   namespace: 'user',
 *   state: { name: '', age: 0 },
 *   getters: {
 *     isAdult: (state) => state.age >= 18,
 *   },
 *   actions: {
 *     setName(name: string) { this.state.name = name },
 *     resetAll() {
 *       this.patch({ name: '', age: 0 })
 *     },
 *   },
 *   persist: true,
 * })
 *
 * store.actions.setName('John')
 * store.patch({ age: 30 })
 * console.log(store.getters.isAdult) // true
 * console.log(store.key)            // "user:user"
 * ```
 */
class Store<
  T extends object,
  G extends Record<string, (...args: any[]) => any> = {},
  A extends Record<string, (...args: any[]) => any> = {},
> {
  private _adapter: StorageAdapter | null = null;
  private _key: string;
  private events: StoreEvent<T>[] = [];
  private watchers: WatchStopHandle[] = [];
  private _persist: boolean | "session" | StorageAdapter;
  private _namespace: string;
  private _initialState: T;

  /** Reactive state (Vue reactive) — mutable */
  readonly state: UnwrapNestedRefs<T>;

  /** Readonly snapshot of the state */
  readonly snap: DeepReadonly<UnwrapNestedRefs<T>>;

  /** Reactive getters (computed) — auto-unwrapped */
  readonly getters: ReturnTypes<G>;

  /** Bound actions */
  readonly actions: {
    [K in keyof A]: (...args: Parameters<A[K]>) => ReturnType<A[K]>;
  };

  constructor(options: StoreOptions<T>) {
    this._persist = options.persist ?? false;
    this._namespace = options.namespace ?? "default";
    this._key = this.buildKey(options.key ?? options.namespace);

    // Resolve the storage adapter
    if (this._persist) {
      const resolved = resolveStorage(
        typeof this._persist === "boolean" ? "local" : this._persist
      );
      this._adapter = resolved.adapter;
    }

    // Restore or initialize the state
    const initialState = this.initializeState(options.state);
    this._initialState = structuredClone(options.state);

    // Create the Vue reactive state
    this.state = reactive(initialState) as UnwrapNestedRefs<T>;
    this.snap = readonly(this.state) as DeepReadonly<UnwrapNestedRefs<T>>;

    // Build the getters (computed → reactive for auto-unwrap)
    this.getters = this.buildGetters(
      (options.getters ?? {}) as unknown as G
    );

    // Build the actions
    this.actions = this.buildActions(
      (options.actions ?? {}) as unknown as A
    );

    // Set up persistence and listeners
    this.setupWatcher();
  }

  // ── Public properties ────────────────────────────────────

  /** Full storage key. Format: `[globalPrefix:]namespace:key` */
  get key(): string {
    return this._key;
  }

  /** Store namespace. */
  get namespace(): string {
    return this._namespace;
  }

  /** Indicates whether persistence is enabled. */
  get isPersisted(): boolean {
    return !!this._persist && this._adapter !== null;
  }

  /** Storage type in use (`'local'`, `'session'`, `'custom'`, or `'none'`). */
  get storageType(): string {
    if (!this._persist) return "none";
    if (typeof this._persist === "object") return "custom";
    return this._persist === "session" ? "session" : "local";
  }

  // ── Getters ──────────────────────────────────────────────

  private buildGetters(gettersDef: G): ReturnTypes<G> {
    const computedGetters: Record<string, ComputedRef<unknown>> = {};

    for (const key of Object.keys(gettersDef)) {
      const fn = (gettersDef as Record<string, Function>)[key];
      if (!fn) continue;
      computedGetters[key] = computed(() => fn(this.state as unknown as T));
    }

    // reactive() auto-unwraps ComputedRef — no need for .value
    return reactive(computedGetters) as unknown as ReturnTypes<G>;
  }

  // ── Actions ──────────────────────────────────────────────

  private buildActions(actionsDef: A): typeof this.actions {
    const context: ActionCtx<T, G> = {
      state: this.state,
      getters: this.getters,
      actions: {} as Record<string, (...args: any[]) => any>,
      patch: this.patch.bind(this),
    };

    const bound: Record<string, (...args: any[]) => any> = {};

    for (const key of Object.keys(actionsDef)) {
      const fn = (actionsDef as Record<string, Function>)[key];
      if (!fn) continue;
      bound[key] = fn.bind(context);
    }

    // Circular link so actions can call each other
    context.actions = bound;

    return bound as typeof this.actions;
  }

  // ── Patch ────────────────────────────────────────────────

  /**
   * Partially updates the state.
   *
   * @example
   * ```ts
   * store.patch({ name: 'Jean', age: 30 })          // partial object
   * store.patch((state) => { state.count++ })       // mutator callback
   * ```
   */
  patch(partial: Partial<T> | ((state: UnwrapNestedRefs<T>) => void)): void {
    if (typeof partial === "function") {
      partial(this.state);
    } else {
      Object.assign(this.state as Record<string, unknown>, partial);
    }
  }

  // ── Storage ──────────────────────────────────────────────

  private buildKey(key?: string): string {
    const baseKey = key ?? "store";
    const parts = [_globalPrefix, this._namespace, baseKey].filter(Boolean);
    return parts.join(":");
  }

  private initializeState(initialState: T): T {
    if (!this._adapter) return { ...initialState };

    try {
      const stored = this._adapter.getItem(this._key);
      if (stored) {
        const restored = JSON.parse(stored);
        return { ...initialState, ...restored } as T;
      }
    } catch (error) {
      console.error(
        `[Store] Failed to restore state from ${this.storageType} storage:`,
        error
      );
    }

    return { ...initialState };
  }

  // ── Watcher ──────────────────────────────────────────────

  private setupWatcher(): void {
    const handle = watch(
      () => this.state,
      (newState, oldState) => {
        // Persist (immediately, no defer)
        if (this._adapter) {
          try {
            this._adapter.setItem(this._key, JSON.stringify(newState));
          } catch (error) {
            console.error(
              `[Store] Failed to persist state to ${this.storageType} storage:`,
              error
            );
          }
        }

        // Notify the listeners
        this.notifyListeners(newState, oldState);
      },
      { deep: true, flush: "sync" }
    );

    this.watchers.push(handle);
  }

  private notifyListeners(
    newState: UnwrapNestedRefs<T>,
    oldState: UnwrapNestedRefs<T>
  ): void {
    for (const event of this.events) {
      if (event.event === "change") {
        try {
          event.callback(newState, oldState);
        } catch (error) {
          console.error("[Store] Error in change listener:", error);
        }
      }
    }
  }

  // ── Events ───────────────────────────────────────────────

  /** Register a listener on state change. */
  on(event: "change", callback: StoreCallback<T>): void {
    this.events.push({ event, callback });
  }

  /** Remove all listeners. */
  off(): void {
    this.events = [];
  }

  // ── Reset ────────────────────────────────────────────────

  /** Reset the state (deep clone of the initial state). */
  reset(): void {
    const clone = structuredClone(this._initialState);
    Object.assign(this.state as Record<string, unknown>, clone);
  }

  /** Clear the persisted storage. */
  clearStorage(): void {
    if (!this._adapter) return;
    try {
      this._adapter.removeItem(this._key);
    } catch (error) {
      console.error(
        `[Store] Failed to clear ${this.storageType} storage:`,
        error
      );
    }
  }

  /** Stop all watchers (cleanup). */
  dispose(): void {
    for (const stop of this.watchers) stop();
    this.watchers = [];
    this.events = [];
  }
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Creates a native Vue 3 reactive store.
 *
 * The getters and actions types are inferred automatically
 * from the options object, with contextual typing on `state` and `this`.
 */
export function createStore<
  T extends object,
  O extends StoreOptions<T>,
>(options: O): Store<T, ExtractGetters<O>, ExtractActions<O>> {
  return new Store(options) as any;
}

// ─── Composables ─────────────────────────────────────────────

/**
 * Vue composable: full store access with automatic cleanup.
 *
 * @example
 * ```ts
 * const { state, snap, getters, actions, patch, on, reset } = useStore(store)
 * ```
 */
export function useStore<
  T extends object,
  G extends Record<string, (...args: any[]) => any> = {},
  A extends Record<string, (...args: any[]) => any> = {},
>(store: Store<T, G, A>) {
  onScopeDispose(() => store.dispose());

  return {
    /** Mutable reactive state */
    state: store.state,

    /** Readonly snapshot (reactive) */
    snap: store.snap,

    /** Reactive getters (computed, auto-unwrapped) */
    getters: store.getters,

    /** Bound actions */
    actions: store.actions,

    /** Partial state update */
    patch: store.patch.bind(store),

    /** Register a listener */
    on: store.on.bind(store),

    /** Remove all listeners */
    off: store.off.bind(store),

    /** Reset the state */
    reset: store.reset.bind(store),

    /** Clear the storage */
    clearStorage: store.clearStorage.bind(store),

    /** Storage key */
    key: store.key,

    /** Store namespace */
    namespace: store.namespace,

    /** Is persistence active? */
    isPersisted: store.isPersisted,

    /** Storage type */
    storageType: store.storageType,
  };
}

/**
 * Vue composable: returns only the reactive readonly snapshot.
 */
export function useSnapshot<T extends object>(
  store: Store<T>
): DeepReadonly<UnwrapNestedRefs<T>> {
  return store.snap;
}

/**
 * Vue composable: creates a watcher on the store state.
 * Returns the stop function.
 */
export function useWatch<T extends object>(
  store: Store<T>,
  callback: WatchCallback<UnwrapNestedRefs<T>>
): WatchStopHandle {
  const stop = watch(() => store.state, callback, { deep: true });
  onScopeDispose(() => stop());
  return stop;
}

/**
 * Vue composable: creates a computed based on the store state.
 */
export function useComputed<T extends object, R>(
  store: Store<T>,
  getter: (state: UnwrapNestedRefs<T>) => R
) {
  return computed(() => getter(store.state));
}

export { Store };
export default createStore;
