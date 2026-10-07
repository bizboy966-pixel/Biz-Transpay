import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useQuery } from '@tanstack/react-query';
import { MobileMoneyForm, MobileMoneyTracker } from './dashboard/Deposit';
import { MoMoLinkForm, MoMoLinkTracker } from './PublicLink';

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useQueryClient: jest.fn(),
}));
jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
  useParams: jest.fn(),
}));
jest.mock('@/api', () => ({ get: jest.fn(), post: jest.fn() }), { virtual: true });
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: {} }) }), { virtual: true });
jest.mock('@/hooks/useFeatures', () => ({ useFeatures: () => ({}) }), { virtual: true });
jest.mock('@/components/SelectionMenu', () => () => null, { virtual: true });
jest.mock('@/components/TurnstileWidget', () => ({
  __esModule: true,
  default: () => null,
  useTurnstileConfig: () => ({}),
}), { virtual: true });
jest.mock('@/components/ComingSoon', () => () => null, { virtual: true });
jest.mock('@/components/DashboardPageLogo', () => () => null, { virtual: true });
jest.mock('@/components/PaymentBrand', () => ({ OperatorLogo: () => null }), { virtual: true });
jest.mock('@/components/Logo', () => ({ Logo: () => null }), { virtual: true });
jest.mock('@/components/LinkLogo', () => () => null, { virtual: true });
jest.mock('@/components/PublicLinkPaymentErrorBoundary',
  () => require('../components/PublicLinkPaymentErrorBoundary'), { virtual: true });
jest.mock('@/constants/countries', () => require('../constants/countries'), { virtual: true });
jest.mock('@/constants/payment', () => require('../constants/payment'), { virtual: true });
jest.mock('@/lib/mobileMoneyFees', () => require('../lib/mobileMoneyFees'), { virtual: true });
jest.mock('sonner', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const orange = {
  code: 'orange_bf', name: 'Orange Burkina Faso', currency: 'XOF',
  min: 100, max: 100000, fee_fixed: 20,
  payment_flow: {
    before_submit: true, otp_required: true,
    ussd_code: '*144*4*6*MONTANT#',
    ussd_template: '*144*4*6*{amount}#',
    steps: [
      'Composez *144*4*6*MONTANT# sur votre téléphone.',
      'Suivez le menu pour générer le code de paiement.',
      'Copiez le code généré dans le champ OTP, puis lancez le paiement.',
    ],
  },
};
const config = {
  mobile_money_enabled: true,
  catalog: [{ country: 'BF', country_label: 'Burkina Faso', operators: [orange] }],
};

describe('Orange USSD instructions use the amount actually paid', () => {
  let root;
  let container;
  let originalFetch;
  let originalClipboard;
  let originalActEnvironment;

  beforeEach(() => {
    originalActEnvironment = global.IS_REACT_ACT_ENVIRONMENT;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    originalFetch = global.fetch;
    originalClipboard = navigator.clipboard;
    global.fetch = jest.fn().mockResolvedValue({ json: async () => config });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: jest.fn().mockResolvedValue() },
    });
    useQuery.mockReturnValue({ data: config, isPending: false });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    global.fetch = originalFetch;
    global.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: originalClipboard,
    });
    jest.clearAllMocks();
  });

  async function change(element, value) {
    await act(async () => {
      const prototype = element.tagName === 'SELECT'
        ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event(
        element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true },
      ));
    });
  }

  function expectInstructions(amount, testId) {
    const card = container.querySelector(`[data-testid="${testId}"]`);
    expect(card.querySelector('code').textContent).toBe(`*144*4*6*${amount}#`);
    expect(card.querySelector('li').textContent).toContain(`*144*4*6*${amount}#`);
    expect(card.textContent).toContain('Suivez le menu pour générer le code de paiement.');
  }

  test('wallet deposit updates instructions and copied code when fee bearer changes', async () => {
    await act(async () => root.render(<MobileMoneyForm onSuccess={jest.fn()} />));
    await change(container.querySelector('[data-testid="momo-country"]'), 'BF');
    await change(container.querySelector('[data-testid="momo-operator"]'), 'orange_bf');
    await change(container.querySelector('input[type="number"]'), '500');
    expectInstructions(500, 'momo-payment-flow');
    await act(async () => container.querySelector('[data-testid="momo-fee-client"]').click());
    expectInstructions(520, 'momo-payment-flow');
    await act(async () => container.querySelector('[aria-label="Copier le code USSD"]').click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('*144*4*6*520#');
    await change(container.querySelector('input[type="number"]'), '600');
    expectInstructions(620, 'momo-payment-flow');
    await act(async () => container.querySelector('[data-testid="momo-fee-merchant"]').click());
    expectInstructions(600, 'momo-payment-flow');
    expect(container.textContent).toContain('580 XOF');
  });

  test.each([
    ['fixed', 'customer', 520],
    ['fixed', 'owner', 500],
    ['free', 'customer', 520],
    ['free', 'owner', 500],
  ])('public %s link with fees borne by %s displays %s', async (type, bearer, expected) => {
    await act(async () => root.render(
      <MoMoLinkForm
        link={{ amount_type: type, amount: 500, min_amount: 100,
          currency: 'XOF', fee_bearer: bearer }}
        turnstile={{ enabled: false }}
        onSuccess={jest.fn()}
      />,
    ));
    await change(container.querySelectorAll('select')[0], 'BF');
    await change(container.querySelectorAll('select')[1], 'orange_bf');
    if (type === 'free') await change(container.querySelector('input[type="number"]'), '500');
    expectInstructions(expected, 'pay-payment-flow');
    await act(async () => container.querySelector('[aria-label="Copier le code USSD"]').click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`*144*4*6*${expected}#`);
    expect(container.textContent).toContain(`${bearer === 'owner' ? 480 : 500} XOF`);
  });

  test.each(['deposit', 'link'])(
    'Moov Burkina %s tracker requests USSD confirmation instead of a notification',
    async (type) => {
      const payment = {
        id: 'test-deposit', status: 'pending', amount: 500, currency: 'XOF',
        phone_number: '51765664', customer_phone: '51765664',
        pending_remaining_seconds: 600,
        instructions: 'Ouvrez la notification sur votre téléphone.',
        payment_flow: {
          kind: 'ussd_confirmation', before_submit: false, otp_required: false,
          ussd_code: '*555*6#',
          instructions: 'Composez *555*6# depuis le numéro Moov Money du dépôt, puis confirmez le paiement.',
          steps: ['Lancez le paiement.', 'Composez *555*6# pour confirmer.'],
        },
      };
      await act(async () => root.render(type === 'deposit'
        ? <MobileMoneyTracker deposit={payment} />
        : <MoMoLinkTracker payment={payment} />));
      expect(container.querySelector('h2').textContent).toBe('Confirmez avec le code USSD');
      expect(container.textContent).not.toContain('notification');
      expect(container.textContent).not.toContain('Paiement effectué avec succès');
      expect(container.querySelector('code').textContent).toBe('*555*6#');
      await act(async () => container.querySelector('[aria-label="Copier le code USSD"]').click());
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('*555*6#');
    },
  );
});
