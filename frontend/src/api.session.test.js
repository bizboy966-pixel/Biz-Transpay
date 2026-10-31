jest.mock('axios', () => {
  const instance = jest.fn().mockResolvedValue({ data: { status: 'pending' } });
  instance.post = jest.fn();
  instance.interceptors = {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  };
  return { __esModule: true, default: {
    create: jest.fn(() => instance), get: jest.fn(),
  } };
});

describe('session rotation during payment status polling', () => {
  let api, refreshBrowserSession, beforeRequest, onError, oldLocation;

  beforeEach(() => {
    jest.resetModules();
    ({ api, refreshBrowserSession } = require('./api'));
    beforeRequest = api.interceptors.request.use.mock.calls[0][0];
    onError = api.interceptors.response.use.mock.calls[0][1];
    oldLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true, value: { pathname: '/dashboard/deposit', href: '/dashboard/deposit' },
    });
  });

  afterEach(() => Object.defineProperty(window, 'location', oldLocation));

  function rejectedRead(config) {
    return { config, response: { status: 401, data: { detail: 'Session révoquée' } } };
  }

  test('old-cookie read retries once after successful rotation instead of logging out', async () => {
    const config = await beforeRequest({ method: 'get', url: '/deposits/mobile-money/test' });
    let resolveRefresh;
    api.post.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const refresh = refreshBrowserSession();
    expect(refreshBrowserSession()).toBe(refresh);
    const retry = onError(rejectedRead(config));
    expect(api).not.toHaveBeenCalled();
    resolveRefresh({ data: { ok: true } });
    await retry;
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ _sessionRetry: true }));
    expect(window.location.href).toBe('/dashboard/deposit');
  });

  test('new status reads wait until rotation finishes', async () => {
    let resolveRefresh;
    api.post.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const refresh = refreshBrowserSession();
    let dispatched = false;
    const waiting = beforeRequest({ method: 'get', url: '/deposits/mobile-money/test' })
      .then((config) => { dispatched = true; return config; });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    resolveRefresh({ data: { ok: true } });
    await refresh;
    expect((await waiting)._sessionGeneration).toBe(1);
  });

  test('genuine expiry still rejects the request and redirects to login', async () => {
    const error = rejectedRead(await beforeRequest({ method: 'get', url: '/auth/me' }));
    await expect(onError(error)).rejects.toBe(error);
    expect(api).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/login');
  });

  test('PayDunya payout errors display the provider message instead of raw JSON', async () => {
    const error = {
      config: {},
      response: {
        status: 422,
        data: {
          detail: {
            code: 'PAYDUNYA_4002',
            message: 'PayDunya a refusé la préparation du retrait. Le montant a été remboursé.',
          },
        },
      },
    };
    await expect(onError(error)).rejects.toBe(error);
    expect(error.response.data.detail).toBe(
      'PayDunya a refusé la préparation du retrait. Le montant a été remboursé.',
    );
  });

  test('financial mutations are never replayed after rotation', async () => {
    api.post.mockResolvedValue({ data: { ok: true } });
    await refreshBrowserSession();
    const error = rejectedRead({ method: 'post', url: '/transfers', _sessionGeneration: 0 });
    await expect(onError(error)).rejects.toBe(error);
    expect(api).not.toHaveBeenCalled();
  });

  test('failed rotation cannot disguise a genuinely unauthorized read', async () => {
    api.post.mockRejectedValue(new Error('Refresh failed'));
    await expect(refreshBrowserSession()).rejects.toThrow('Refresh failed');
    const error = rejectedRead({ method: 'get', url: '/auth/me', _sessionGeneration: 0 });
    await expect(onError(error)).rejects.toBe(error);
    expect(api).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/login');
  });

  test('a retried read that is still unauthorized cannot retry indefinitely', async () => {
    api.post.mockResolvedValue({ data: { ok: true } });
    await refreshBrowserSession();
    const error = rejectedRead({ method: 'get', url: '/auth/me',
      _sessionGeneration: 0, _sessionRetry: true });
    await expect(onError(error)).rejects.toBe(error);
    expect(api).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/login');
  });
});
