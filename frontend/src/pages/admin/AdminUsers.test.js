import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import api from '@/api';
import AdminUsers from './AdminUsers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}), { virtual: true });

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'admin' } }),
}), { virtual: true });

jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => jest.fn(),
}));

describe('AdminUsers search', () => {
  let container;
  let root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    api.get.mockResolvedValue({
      data: [{
        id: 'user-1',
        full_name: 'Mamadou Diallo',
        username: 'mamadou',
        email: 'mamadou@example.test',
        phone: '+22890001122',
        country: 'TG',
        balance_xof: 0,
        balance_xaf: 0,
      }],
    });
  });

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container.remove();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('searches as the admin types and sends the current query', async () => {
    await act(async () => root.render(<AdminUsers />));
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
    expect(api.get).toHaveBeenCalledWith('/admin/users', { params: {} });

    const input = container.querySelector('[data-testid="user-search"]');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value',
    ).set;
    await act(async () => {
      setValue.call(input, '+228 90-00 11 22');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      jest.advanceTimersByTime(249);
      await Promise.resolve();
    });
    expect(api.get).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.get).toHaveBeenLastCalledWith('/admin/users', {
      params: { q: '+228 90-00 11 22' },
    });
  });
});
