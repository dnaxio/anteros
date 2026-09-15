/**
 * @anteros/store — Reactive store with persistence (Vue 3)
 *
 * Uses Vue's native reactivity (reactive, readonly, watch).
 * Persistence via localStorage, sessionStorage, or a custom adapter.
 *
 * @example
 * ```vue
 * <script setup>
 * import { createStore, useStore } from '@anteros/store'
 *
 * const store = createStore({
 *   namespace: 'app',
 *   state: { count: 0 },
 *   getters: { double: (state) => state.count * 2 },
 *   actions: { increment() { this.state.count++ } },
 *   persist: true,
 * })
 *
 * const { state, snap, getters, actions, patch } = useStore(store)
 * </script>
 *
 * <template>
 *   <p>{{ snap.count }} (double: {{ getters.double }})</p>
 *   <button @click="actions.increment()">+1</button>
 * </template>
 * ```
 */

export {
  createStore,
  Store,
  useStore,
  useSnapshot,
  useWatch,
  useComputed,
  setStoragePrefix,
  getStoragePrefix,
  type StoreOptions,
  type StorageAdapter,
} from "./vue";
