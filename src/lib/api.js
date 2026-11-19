let csrfToken = '';

export function setCsrfToken(token) {
  csrfToken = token || '';
}

export class ApiError extends Error {
  constructor(message, status, errors = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
  }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, headers = {}, signal } = options;
  const requestHeaders = { ...headers };
  const request = {
    method,
    credentials: 'same-origin',
    headers: requestHeaders,
    signal,
  };

  if (body instanceof FormData) {
    request.body = body;
  } else if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    request.body = JSON.stringify(body);
  }

  if (!['GET', 'HEAD'].includes(method) && csrfToken) {
    requestHeaders['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(path, request);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload?.message || (response.status === 413
        ? 'Foto terlalu besar untuk diunggah. Pilih foto lebih kecil lalu coba lagi.'
        : 'Terjadi kesalahan. Coba lagi sebentar lagi.'),
      response.status,
      payload?.errors || [],
    );
  }

  return payload;
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date(value));
  } catch {
    return '—';
  }
}

export function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return '—';
  }
}
