import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import PublicLinkPaymentErrorBoundary from './PublicLinkPaymentErrorBoundary';

function BrokenTracker() {
  throw new Error('simulated tracker render failure');
}

describe('PublicLinkPaymentErrorBoundary', () => {
  let container;
  let root;
  let originalFetch;
  let originalActEnvironment;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = global.fetch;
    originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
    }
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
    if (originalActEnvironment === undefined) {
      delete global.IS_REACT_ACT_ENVIRONMENT;
    } else {
      global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    }
    jest.restoreAllMocks();
    container.remove();
  });

  it('shows the server-confirmed failure state when the tracker cannot render', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'failed' }),
    });
    global.fetch = fetchMock;

    await act(async () => {
      root.render(
        <PublicLinkPaymentErrorBoundary payment={{ id: 'payment-test', status: 'pending' }}>
          <BrokenTracker />
        </PublicLinkPaymentErrorBoundary>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Paiement échoué');
    expect(container.textContent).toContain('contactez le marchand avant de réessayer');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/links/payments/payment-test'),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/links/pay/mobile-money'),
    );
  });
});