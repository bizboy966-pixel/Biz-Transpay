import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  getPwaInstallState,
  markPwaInstalled,
  requestPwaInstall,
  subscribePwaInstall,
} from '../lib/pwaInstall';
import PwaInstallPrompt from './PwaInstallPrompt';

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/dashboard' }),
}));

jest.mock('../lib/pwaInstall', () => ({
  getPwaInstallState: jest.fn(),
  markPwaInstalled: jest.fn(),
  requestPwaInstall: jest.fn(),
  subscribePwaInstall: jest.fn(() => () => {}),
}));

describe('PwaInstallPrompt', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    getPwaInstallState.mockReturnValue({ installed: false, canPrompt: true });
    requestPwaInstall.mockResolvedValue('accepted');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  const renderPrompt = async () => {
    await act(async () => root.render(<PwaInstallPrompt />));
  };

  it('shows all three choices when the user has not installed the app', async () => {
    await renderPrompt();

    expect(container.querySelector('[data-testid="btn-dismiss-pwa-prompt"]')?.textContent)
      .toContain('Plus tard');
    expect(container.querySelector('[data-testid="btn-confirm-pwa-installed"]')?.textContent)
      .toContain('J’ai installé l’application');
    expect(container.querySelector('[data-testid="btn-install-pwa"]')?.textContent)
      .toContain('Installer l’application');
  });

  it('opens the browser install prompt from the install button', async () => {
    await renderPrompt();

    await act(async () => {
      container.querySelector('[data-testid="btn-install-pwa"]').click();
    });

    expect(requestPwaInstall).toHaveBeenCalledTimes(1);
  });

  it('shows platform instructions when native installation is unavailable', async () => {
    getPwaInstallState.mockReturnValue({ installed: false, canPrompt: false });
    requestPwaInstall.mockResolvedValue('unavailable');
    await renderPrompt();

    await act(async () => {
      container.querySelector('[data-testid="btn-install-pwa"]').click();
    });

    expect(container.querySelector('[data-testid="pwa-install-instructions"]'))
      .not.toBeNull();
    expect(container.querySelector('[data-testid="btn-install-pwa"]')).not.toBeNull();
  });

  it('lets users confirm they installed the app manually', async () => {
    await renderPrompt();

    await act(async () => {
      container.querySelector('[data-testid="btn-confirm-pwa-installed"]').click();
    });

    expect(markPwaInstalled).toHaveBeenCalledTimes(1);
  });

  it('lets users postpone installation', async () => {
    await renderPrompt();

    await act(async () => {
      container.querySelector('[data-testid="btn-dismiss-pwa-prompt"]').click();
    });

    expect(container.querySelector('[data-testid="pwa-install-prompt"]')).toBeNull();
  });
});