/**
 * API ??????
 *
 * ???? Axios ??????????????????????????
 */
import axios from 'axios';
import useAuthStore from '@store/useAuthStore';
import useConfigStore from '@store/useConfigStore';

/**
 * Axios API 客户端。
 *
 * 负责规范化服务端地址、注入认证头、禁用同步接口 GET 缓存，以及在
 * 使用自托管服务的访问密钥，不请求官方登录或令牌刷新接口。
 */
const apiClient = axios.create({ timeout: 30000 });

/**
 * 把用户输入的服务器地址规整成可直接给 axios 使用的 baseURL。
 */
export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('The configured sync server URL is empty');
    error.code = 'INVALID_SERVER_URL';
    throw error;
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) {
    const error = new Error('The configured sync server must use HTTP or HTTPS');
    error.code = 'INVALID_SERVER_URL';
    throw error;
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
    if (!url.hostname || url.username || url.password) {
      throw new Error('The sync server URL contains invalid authority fields');
    }
    if (url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
      throw new Error('The sync server URL must not contain a query, fragment or encoded slash');
    }
    return url.toString().replace(/\/+$/, '');
  } catch (cause) {
    const error = new Error('The configured sync server URL is invalid');
    error.code = 'INVALID_SERVER_URL';
    error.cause = cause;
    throw error;
  }
}

export function getApiBaseUrl() {
  const configured = useConfigStore.getState().serverUrl;
  return normalizeBaseUrl(configured);
}

/**
 * 归类接口错误，供同步引擎决定 UI 状态与重试策略。
 */
export function classifyApiError(error) {
  const status = error?.response?.status || 0;
  const code = error?.code || '';
  const message = String(error?.message || '').toLowerCase();

  if (code === 'SYNC_INTEGRITY_ERROR') return 'integrity_error';
  if (code === 'SYNC_PROTOCOL_ERROR' || code === 'INVALID_SERVER_URL') return 'protocol_error';
  if (status === 401) return 'auth_required';
  if (status === 408 || status === 425) return 'offline';
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'payload_too_large';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'request_error';

  if (message.includes('name not resolved') || message.includes('err_name_not_resolved')) {
    return 'server_unreachable';
  }
  if (message.includes('proxy_connection_failed') || message.includes('proxy')) {
    return 'offline';
  }
  if (code === 'ERR_NETWORK' || code === 'ECONNABORTED') {
    return 'offline';
  }
  return 'error';
}

/**
 * ??????
 *
 * ?????? baseURL????????????????
 */
apiClient.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  const auth = useAuthStore.getState();
  const token = auth.token;
  config._syncAuthUserId ??= String(auth.user?.id || 'guest');
  config._syncBaseURL ??= config.baseURL;
  if (token && !config._serviceProbe) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (
    typeof config.url === 'string' &&
    config.url.startsWith('/sync/') &&
    String(config.method || 'get').toLowerCase() === 'get'
  ) {
    // 同步查询必须永远命中最新服务端状态，否则增量 cursor 和冲突判定
    // 会被中间层缓存污染。
    config.headers['Cache-Control'] = 'no-cache, no-store, max-age=0';
    config.headers.Pragma = 'no-cache';
    config.headers.Expires = '0';
  }
  return config;
});

// Service access keys do not use account login or refresh endpoints.
export default apiClient;
