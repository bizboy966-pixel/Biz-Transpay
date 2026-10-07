import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import WithdrawalStatusModal from './WithdrawalStatusModal';

describe('WithdrawalStatusModal', () => {
  let container;
  let root;
  let onClose;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = jest.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the processing spinner visible without a close action', async () => {
    await act(async () => {
      root.render(<WithdrawalStatusModal status="processing" onClose={onClose} />);
    });

    expect(container.textContent).toContain('Traitement en cours');
    expect(container.textContent).toContain(
      'Veuillez patienter pendant le traitement de votre retrait…',
    );
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    ['success', 'Retrait réussi'],
    ['failed', 'Retrait échoué'],
    ['pending', 'Retrait toujours en cours'],
  ])('shows the real %s result with a close action', async (status, title) => {
    await act(async () => {
      root.render(<WithdrawalStatusModal status={status} onClose={onClose} />);
    });

    expect(container.textContent).toContain(title);
    const closeButton = container.querySelector('button');
    expect(closeButton?.textContent).toBe('Fermer');
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
