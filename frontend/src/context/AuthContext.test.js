import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../api';
import { AuthProvider, useAuth } from './AuthContext';
import {
  currentPushToken,
  disableBrowserPush,
  startBrowserPush,
} from '../lib/pushNotifications';

jest.mock('../api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
  refreshBrowserSession: jest.fn(),
}));
jest.mock('../lib/pushNotifications', () => ({
  __esModule: true,
  currentPushToken: jest.fn(),
  disableBrowserPush: jest.fn(),
  PUSH_OPT_IN_DISMISSED_KEY: 'btp_push_opt_in_dismissed',
  startBrowserPush: jest.fn(),
}));

let auth;

function CaptureAuth() {
  auth = useAuth();
  return null;
}

describe('AuthContext push enrollment', () => {
  let container;
  let root;
  const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    auth = null;
    api.get.mockResolvedValue({ data: { id: 'user-1', role: 'user' } });
    api.post.mockResolvedValue({ data: {} });
    currentPushToken.mockReturnValue('registered-token');
    disableBrowserPush.mockResolvedValue(undefined);
    startBrowserPush.mockResolvedValue('registered-token');
    localStorage.setItem('btp_push_token', 'registered-token');
    sessionStorage.setItem('btp_push_opt_in_dismissed', '1');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '/dashboard' },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    localStorage.clear();
    sessionStorage.clear();
    delete global.IS_REACT_ACT_ENVIRONMENT;
    Object.defineProperty(window, 'location', originalLocation);
    jest.clearAllMocks();
  });

  it('keeps the registered push device when the user logs out', async () => {
    await act(async () => {
      root.render(<AuthProvider><CaptureAuth /></AuthProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(auth.user.id).toBe('user-1');
    expect(startBrowserPush).toHaveBeenCalledWith();

    await act(async () => auth.logout());

    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    expect(disableBrowserPush).not.toHaveBeenCalled();
    expect(localStorage.getItem('btp_push_token')).toBe('registered-token');
    expect(sessionStorage.getItem('btp_push_opt_in_dismissed')).toBeNull();
    expect(window.location.href).toBe('/');
  });
});
