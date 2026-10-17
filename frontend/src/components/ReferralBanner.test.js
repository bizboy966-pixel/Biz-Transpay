import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ReferralBanner from './ReferralBanner';

jest.mock('react-router-dom', () => ({
  Link: ({ to, ...props }) => <a href={to} {...props} />,
}));

describe('ReferralBanner', () => {
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

  test('is a keyboard-accessible referral link with one accessible copy of its message', async () => {
    await act(async () => root.render(<ReferralBanner />));

    const banner = container.querySelector('[data-testid="referral-banner"]');
    const message = 'Parrainez et recevez jusqu’à 2,5 % sur la première transaction de recharge de vos filleuls.';
    expect(banner.getAttribute('href')).toBe('/dashboard/profile#referral');
    expect(banner.getAttribute('aria-label')).toBe(message);
    expect(banner.querySelectorAll('.bt-referral-banner__message')).toHaveLength(2);
    expect(banner.querySelector('.bt-referral-banner__viewport').getAttribute('aria-hidden')).toBe('true');
    expect(banner.textContent).toBe(`${message}${message}`);
  });
});
