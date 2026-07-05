/**
 * @anteros/store/vue — Store réactif natif Vue 3
 *
 * Utilise la réactivité native de Vue (reactive, readonly, watch).
 * Persistance via localStorage, sessionStorage, ou adapter personnalisé.
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

/** Interface minimale pour un moteur de stockage (localStorage, sessionStorage, custom). */
export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Résout l'adapter de stockage pour un environnement donné. */
function resolveStorage(type: "local" | "session" | StorageAdapter): {
  adapter: StorageAdapter | null;
  label: string;
} {
  if (typeof type === "object") {
    return { adapter: type, label: "custom" };
  }

  // SSR / environnements sans window
  if (typeof globalThis === "undefined") {
    return { adapter: null, label: "none (SSR)" };
  }

  const win = globalThis as any;
  const storage = type === "session" ? win.sessionStorage : win.localStorage;
  return { adapter: storage, label: type };
}

/**
 * Préfixe global optionnel appliqué à toutes les clés de stockage.
 *
 * @example
 * ```ts
 * import { setStoragePrefix } from '@anteros/store/vue'
 * setStoragePrefix('myapp')
 * // clé finale : myapp:cart:items
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
 * Extrait le type de retour de chaque fonction d'un record.
 * Ex: { double: (s: any) => number } → { double: number }
 * Un objet vide `{}` (keyof = never) produit `{}`.
 */
type ReturnTypes<T extends Record<string, (...args: any[]) => any>> =
  keyof T extends never ? {} : { [K in keyof T]: ReturnType<T[K]> };

/**
 * Contexte `this` disponible dans les actions.
 */
type ActionCtx<T extends object, G extends Record<string, (...args: any[]) => any>> = {
  state: UnwrapNestedRefs<T>;
  getters: ReturnTypes<G>;
  actions: Record<string, (...args: any[]) => any>;
  patch: (partial: Partial<T> | ((state: UnwrapNestedRefs<T>) => void)) => void;
};

// ─── StoreOptions (inférence friendly) ────────────────────────

/**
 * Options pour la création d'un store.
 *
 * Les champs `getters` et `actions` utilisent des types concrets (non génériques)
 * pour que TypeScript puisse fournir du **contextual typing** sur les paramètres
 * des fonctions (`state` dans les getters, `this` dans les actions).
 */
export interface StoreOptions<T extends object> {
  /** Clé unique pour le storage (défaut: namespace).
   * Ex: `'cart'` → clé finale `prefix:namespace:cart` */
  key?: string;
  /** Namespace pour isoler le storage (défaut: `'default'`).
   * Sert aussi de clé par défaut si `key` n'est pas fournie. */
  namespace?: string;
  /** État initial du store */
  state: T;
  /** Getters : fonctions dérivées du state (réactives via computed) */
  getters?: Record<string, (state: T) => any>;
  /** Actions : méthodes mutatrices */
  actions?: Record<
    string,
    (this: ActionCtx<T, Record<string, (...args: any[]) => any>>, ...args: any[]) => any
  >;
  /**
   * Persister l'état dans le stockage.
   * - `true` → localStorage
   * - `'session'` → sessionStorage
   * - `StorageAdapter` → moteur personnalisé
   * - `false` → pas de persistance (défaut)
   */
  persist?: boolean | "session" | StorageAdapter;
}

/** Extrait le type précis des getters d'un objet d'options. */
type ExtractGetters<O extends StoreOptions<any>> =
  O extends { getters: infer G } ? G : {};

/** Extrait le type précis des actions d'un objet d'options. */
type ExtractActions<O extends StoreOptions<any>> =
  O extends { actions: infer A } ? A : {};

/**
 * Callback pour les événements du store
 */
type StoreCallback<T extends object> = (
  state: UnwrapNestedRefs<T>,
  oldValue: UnwrapNestedRefs<T>
) => void;

/**
 * Événement enregistré dans le store
 */
interface StoreEvent<T extends object> {
  event: string;
  callback: StoreCallback<T>;
}

// ─── Store ───────────────────────────────────────────────────

/**
 * Store réactif natif Vue 3
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

  /** État réactif (Vue reactive) — mutable */
  readonly state: UnwrapNestedRefs<T>;

  /** Snapshot readonly de l'état */
  readonly snap: DeepReadonly<UnwrapNestedRefs<T>>;

  /** Getters réactifs (computed) — auto-unwrapped */
  readonly getters: ReturnTypes<G>;

  /** Actions bindées */
  readonly actions: {
    [K in keyof A]: (...args: Parameters<A[K]>) => ReturnType<A[K]>;
  };

  constructor(options: StoreOptions<T>) {
    this._persist = options.persist ?? false;
    this._namespace = options.namespace ?? "default";
    this._key = this.buildKey(options.key ?? options.namespace);

    // Résoudre l'adapter de stockage
    if (this._persist) {
      const resolved = resolveStorage(
        typeof this._persist === "boolean" ? "local" : this._persist
      );
      this._adapter = resolved.adapter;
    }

    // Restaurer ou initialiser l'état
    const initialState = this.initializeState(options.state);
    this._initialState = structuredClone(options.state);

    // Créer l'état réactif Vue
    this.state = reactive(initialState) as UnwrapNestedRefs<T>;
    this.snap = readonly(this.state) as DeepReadonly<UnwrapNestedRefs<T>>;

    // Construire les getters (computed → reactive pour auto-unwrap)
    this.getters = this.buildGetters(
      (options.getters ?? {}) as unknown as G
    );

    // Construire les actions
    this.actions = this.buildActions(
      (options.actions ?? {}) as unknown as A
    );

    // Configurer la persistance et les listeners
    this.setupWatcher();
  }

  // ── Propriétés publiques ──────────────────────────────────

  /** Clé de stockage complète. Format : `[globalPrefix:]namespace:key` */
  get key(): string {
    return this._key;
  }

  /** Namespace du store. */
  get namespace(): string {
    return this._namespace;
  }

  /** Indique si la persistance est activée. */
  get isPersisted(): boolean {
    return !!this._persist && this._adapter !== null;
  }

  /** Type de stockage utilisé (`'local'`, `'session'`, `'custom'`, ou `'none'`). */
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

    // reactive() auto-déballe les ComputedRef — pas besoin de .value
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

    // Lien circulaire pour que les actions puissent s'appeler entre elles
    context.actions = bound;

    return bound as typeof this.actions;
  }

  // ── Patch ────────────────────────────────────────────────

  /**
   * Met à jour partiellement le state.
   *
   * @example
   * ```ts
   * store.patch({ name: 'Jean', age: 30 })          // objet partiel
   * store.patch((state) => { state.count++ })       // callback mutateur
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
        // Persister (immédiatement, pas de defer)
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

        // Notifier les listeners
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

  // ── Événements ───────────────────────────────────────────

  /** Enregistrer un listener sur le changement d'état. */
  on(event: "change", callback: StoreCallback<T>): void {
    this.events.push({ event, callback });
  }

  /** Supprimer tous les listeners. */
  off(): void {
    this.events = [];
  }

  // ── Reset ────────────────────────────────────────────────

  /** Réinitialiser l'état (deep clone de l'état initial). */
  reset(): void {
    const clone = structuredClone(this._initialState);
    Object.assign(this.state as Record<string, unknown>, clone);
  }

  /** Effacer le storage persisté. */
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

  /** Arrêter tous les watchers (cleanup). */
  dispose(): void {
    for (const stop of this.watchers) stop();
    this.watchers = [];
    this.events = [];
  }
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Crée un store réactif natif Vue 3.
 *
 * Les types des getters et actions sont inférés automatiquement
 * depuis l'objet d'options, avec contextual typing sur `state` et `this`.
 */
export function createStore<
  T extends object,
  O extends StoreOptions<T>,
>(options: O): Store<T, ExtractGetters<O>, ExtractActions<O>> {
  return new Store(options) as any;
}

// ─── Composables ─────────────────────────────────────────────

/**
 * Composable Vue : accès complet au store avec cleanup automatique.
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
    /** État réactif mutable */
    state: store.state,

    /** Snapshot readonly (réactif) */
    snap: store.snap,

    /** Getters réactifs (computed, auto-unwrapped) */
    getters: store.getters,

    /** Actions bindées */
    actions: store.actions,

    /** Mise à jour partielle du state */
    patch: store.patch.bind(store),

    /** Enregistrer un listener */
    on: store.on.bind(store),

    /** Supprimer tous les listeners */
    off: store.off.bind(store),

    /** Réinitialiser le state */
    reset: store.reset.bind(store),

    /** Effacer le storage */
    clearStorage: store.clearStorage.bind(store),

    /** Clé de stockage */
    key: store.key,

    /** Namespace du store */
    namespace: store.namespace,

    /** La persistance est-elle active ? */
    isPersisted: store.isPersisted,

    /** Type de stockage */
    storageType: store.storageType,
  };
}

/**
 * Composable Vue : retourne uniquement le snapshot readonly réactif.
 */
export function useSnapshot<T extends object>(
  store: Store<T>
): DeepReadonly<UnwrapNestedRefs<T>> {
  return store.snap;
}

/**
 * Composable Vue : crée un watcher sur le state du store.
 * Retourne la fonction d'arrêt.
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
 * Composable Vue : crée un computed basé sur le state du store.
 */
export function useComputed<T extends object, R>(
  store: Store<T>,
  getter: (state: UnwrapNestedRefs<T>) => R
) {
  return computed(() => getter(store.state));
}

export { Store };
export default createStore;
