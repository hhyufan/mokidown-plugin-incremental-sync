import { create } from 'zustand';
import apiClient, { getApiBaseUrl } from '@/services/apiClient';
import useConfigStore from './useConfigStore';
import { deleteRefreshCredential, getRefreshCredential, setRefreshCredential } from '@utils/tauriApi';

let restoring = null;
let revision = 0;
const connectionStore = () => import('@tauri-apps/plugin-store').then(({ load }) => load('sync-connection.json'));

// Legacy field names preserve the sync engine's connection contract.
// No accounts, passwords, refresh endpoints or vendor service are used.
const useAuthStore = create((set, get) => ({
  user: null, token: null, isLoggedIn: false, loading: false,
  connect: async (accessKey, { persist = true } = {}) => {
    const currentRevision = ++revision;
    const endpoint = getApiBaseUrl();
    set({ loading: true, user: null, token: null, isLoggedIn: false });
    try {
      if (!accessKey || accessKey.length < 32) throw new Error('A service access key of at least 32 characters is required');
      const { data } = await apiClient.get('/capabilities', {
        headers: { Authorization: `Bearer ${accessKey}` }, _serviceProbe: true,
      });
      if (data?.service !== 'mokidown-plugin-server'
        || !/^[a-zA-Z0-9_-]{8,80}$/.test(data.instanceId || '')
        || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.namespace || '')
        || !data.plugins?.some((plugin) => plugin.id === 'cloud-sync' && plugin.protocolVersion === 3)) {
        throw new Error('The server does not provide the cloud-sync v3 plugin');
      }
      const assertCurrent = () => {
        if (currentRevision !== revision || endpoint !== getApiBaseUrl()) throw new Error('Sync connection changed');
      };
      assertCurrent();
      const user = { id: `sync:${endpoint}:${data.instanceId}:${data.namespace}`, username: data.namespace, email: endpoint };
      if (persist) {
        const store = await connectionStore();
        assertCurrent();
        // Reuse native secure credential storage; never export access keys.
        await setRefreshCredential(accessKey);
        assertCurrent();
        await store.set('endpoint', endpoint);
        await store.save();
        assertCurrent();
      }
      set({ user, token: accessKey, isLoggedIn: true, loading: false });
      return data;
    } catch (error) {
      if (currentRevision === revision) set({ loading: false });
      throw error;
    }
  },
  loadToken: () => {
    if (!useConfigStore.getState().syncEnabled || get().isLoggedIn) return Promise.resolve();
    if (restoring) return restoring;
    const started = revision;
    restoring = (async () => {
      try {
        const store = await connectionStore();
        const endpoint = await store.get('endpoint');
        if (endpoint !== getApiBaseUrl() || started !== revision) return;
        const key = await getRefreshCredential();
        if (key && started === revision) await get().connect(key, { persist: false });
      } catch { /* Keep saved connection through temporary outages. */ }
    })().finally(() => { restoring = null; });
    return restoring;
  },
  clearSession: async () => {
    revision += 1;
    set({ user: null, token: null, isLoggedIn: false, loading: false });
    await Promise.allSettled([
      deleteRefreshCredential(),
      connectionStore().then(async (store) => { await store.delete('endpoint'); await store.save(); }),
    ]);
  },
  logout: () => get().clearSession(),
}));

export default useAuthStore;
