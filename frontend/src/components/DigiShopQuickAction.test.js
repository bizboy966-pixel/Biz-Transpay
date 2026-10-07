import { act } from 'react';
import { createRoot } from 'react-dom/client';
import DigiShopQuickAction from './DigiShopQuickAction';

describe('DigiShop dashboard action', () => {
  let container;
  let root;
  let originalActEnvironment;

  beforeEach(() => {
    originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
  });

  test('opens a small coming-soon dialog and closes without navigating', async () => {
    await act(async () => root.render(<DigiShopQuickAction />));
    expect(container.querySelector('[data-testid="quick-action-digishop"]')?.textContent)
      .toBe('DigiShop');
    expect(container.querySelector('[data-testid="quick-action-digishop"] img')?.getAttribute('src'))
      .toBeTruthy();
    expect(document.body.querySelector('[data-testid="digishop-modal"]')).toBeNull();

    await act(async () => {
      container.querySelector('[data-testid="quick-action-digishop"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('[data-testid="digishop-modal"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="digishop-status"]')?.textContent)
      .toBe('Bientôt disponible 🚀');
    expect(document.body.querySelector('[data-testid="digishop-modal"] img')?.getAttribute('src'))
      .toBeTruthy();

    await act(async () => {
      document.body.querySelector('[data-testid="digishop-close"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('[data-testid="digishop-modal"]')).toBeNull();
  });
});
