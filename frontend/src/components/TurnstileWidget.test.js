import { act } from 'react';
import { createRoot } from 'react-dom/client';
import TurnstileWidget from './TurnstileWidget';

describe('TurnstileWidget', () => {
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    delete window.turnstile;
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not break route navigation when Cloudflare cleanup throws', async () => {
    window.turnstile = {
      render: jest.fn(() => 'widget-id'),
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
    expect(window.turnstile.remove).toHaveBeenCalledWith('widget-id');
  });
});