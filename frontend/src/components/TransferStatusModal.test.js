import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import TransferStatusModal from './TransferStatusModal';

describe('TransferStatusModal', () => {
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

  it.each([
    ['biz_to_biz', 'transfert'],
    ['biz_to_mobile', 'retrait'],
    ['biz_to_crypto', 'retrait'],
  ])('shows a continuous processing state for %s', async (transferType, action) => {
    await act(async () => {
      root.render(
        <TransferStatusModal
          status="processing"
          transferType={transferType}
          onClose={onClose}
        />,
      );
    });

    expect(container.textContent).toContain('Traitement en cours');
    expect(container.textContent).toContain(
      `Veuillez patienter pendant le traitement de votre ${action}…`,
    );
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    ['biz_to_biz', 'success', 'Transfert réussi'],
    ['biz_to_biz', 'failed', 'Transfert échoué'],
    ['biz_to_biz', 'pending', 'Transfert toujours en cours'],
    ['biz_to_mobile', 'success', 'Retrait réussi'],
    ['biz_to_mobile', 'failed', 'Retrait échoué'],
    ['biz_to_mobile', 'pending', 'Retrait toujours en cours'],
    ['biz_to_crypto', 'success', 'Retrait réussi'],
    ['biz_to_crypto', 'failed', 'Retrait échoué'],
    ['biz_to_crypto', 'pending', 'Retrait toujours en cours'],
  ])('shows the %s %s result with a close action', async (transferType, status, title) => {
    await act(async () => {
      root.render(
        <TransferStatusModal
          status={status}
          transferType={transferType}
          onClose={onClose}
        />,
      );
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
