import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import PersistentNotificationModal from './PersistentNotificationModal';

jest.mock('../context/AuthContext', () => ({
  __esModule: true,
  useAuth: jest.fn(),
}));

jest.mock('react-router-dom', () => {
  const ReactRuntime = require('react');
  return {
    Link: ({ to, children, ...props }) => ReactRuntime.createElement(
      'a', { ...props, href: to }, children,
    ),
  };
});

jest.mock('../api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const importantNotification = {
  id: 'push-1',
  user_id: 'user-1',
  type: 'admin_push',
  title: 'Maintenance programmée',
  body: 'Le service sera indisponible demain de 08 h à 09 h.',
  data: { url: '/dashboard/transactions' },
  read: false,
  requires_confirmation: true,
  created_at: '2026-10-08T09:00:00.000Z',
};

describe('PersistentNotificationModal', () => {
  let container;
  let root;

  const renderModal = async () => {
    await act(async () => {
      root.render(<PersistentNotificationModal />);
    });
  };

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    useAuth.mockReturnValue({ user: { id: 'user-1' }, loading: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockResolvedValue({ data: [importantNotification] });
    api.post.mockResolvedValue({ data: { ok: true } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    jest.clearAllMocks();
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the full unread notice after login and confirms it through the existing read route', async () => {
    api.get.mockResolvedValueOnce({
      data: [
        importantNotification,
        { ...importantNotification, id: 'push-other', user_id: 'user-2', title: 'Message privé' },
      ],
    });
    await renderModal();

    expect(container.textContent).toContain('Maintenance programmée');
    expect(container.textContent).toContain(importantNotification.body);
    expect(container.textContent).not.toContain('Message privé');
    expect(container.textContent).toContain('Envoyée le');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      container.querySelector('[data-testid="persistent-notification-confirm"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(api.post).toHaveBeenCalledWith('/notifications/push-1/read');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('dismisses without marking read and shows again after the user reconnects', async () => {
    await renderModal();
    await act(async () => {
      container.querySelector('[data-testid="persistent-notification-dismiss"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(api.post).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      useAuth.mockReturnValue({ user: null, loading: false });
      root.render(<PersistentNotificationModal />);
    });
    await act(async () => {
      useAuth.mockReturnValue({ user: { id: 'user-1' }, loading: false });
      root.render(<PersistentNotificationModal />);
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the notice open when the acknowledgement request fails', async () => {
    api.post.mockRejectedValueOnce(new Error('network error'));
    await renderModal();

    await act(async () => {
      container.querySelector('[data-testid="persistent-notification-confirm"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('La confirmation n’a pas été enregistrée');
  });
});
