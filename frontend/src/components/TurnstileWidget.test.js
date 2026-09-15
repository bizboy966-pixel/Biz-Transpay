import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TurnstileWidget from './TurnstileWidget';

describe('TurnstileWidget', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    delete window.turnstile;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  it('lets React remove the host node before Cloudflare cleanup runs', async () => {
    window.turnstile = {
      render: jest.fn((mountNode) => {
        // The SDK is allowed to mutate or replace its imperative mount node.
        // Doing this to a React-owned node caused the production crash.
        mountNode.remove();
        return 'widget-id';
      }),
      remove: jest.fn(() => {
        throw { code: 'widget-already-detached' }; // eslint-disable-line no-throw-literal
      }),
    };

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <TurnstileWidget
          siteKey="test-site-key"
          action="login"
          onToken={jest.fn()}
        />,
      );
    });

    expect(() => {
      act(() => root.unmount());
    }).not.toThrow();

    expect(window.turnstile.remove).not.toHaveBeenCalled();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(window.turnstile.remove).toHaveBeenCalledWith('widget-id');
  });

  it('keeps delayed cleanup from touching a replacement widget', async () => {
    let sequence = 0;
    window.turnstile = {
      render: jest.fn(() => `widget-${++sequence}`),
      remove: jest.fn(),
    };

    const container = document.createElement('div');
    const root = createRoot(container);
    const onToken = jest.fn();

    await act(async () => {
      root.render(
        <TurnstileWidget
          siteKey="test-site-key"
          action="login"
          onToken={onToken}
        />,
      );
    });

    const firstIsland = container.querySelector('.turnstile-widget__island');
    expect(firstIsland).not.toBeNull();

    await act(async () => {
      root.render(
        <TurnstileWidget
          siteKey="test-site-key"
          action="register"
          onToken={onToken}
        />,
      );
    });

    const secondIsland = container.querySelector('.turnstile-widget__island');
    expect(secondIsland).not.toBe(firstIsland);
    expect(firstIsland.parentNode).toBeNull();
    expect(secondIsland.parentNode).not.toBeNull();

    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(window.turnstile.remove).toHaveBeenCalledWith('widget-1');
    expect(secondIsland.parentNode).not.toBeNull();

    act(() => root.unmount());
  });
});