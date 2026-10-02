import { Component, useEffect, useState } from 'react';

const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'expired'];

export default class PublicLinkPaymentErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error(
      '[public-payment] Mobile Money status tracker render failed:',
      error?.name || 'Error',
      error?.message || 'unknown error',
    );
  }

  render() {
    if (this.state.hasError) {
      return <PaymentStatusFallback payment={this.props.payment} />;
    }
    return this.props.children;
  }
}

function PaymentStatusFallback({ payment }) {
  const [status, setStatus] = useState(payment?.status || 'pending');

  useEffect(() => {
    if (!payment?.id || status !== 'pending') return undefined;
    let active = true;
    let timer;

    const refreshStatus = async () => {
      try {
        const response = await fetch(
          `${process.env.REACT_APP_BACKEND_URL || ''}/api/links/payments/${encodeURIComponent(payment.id)}`,
        );
        const data = await response.json();
        if (response.ok && active && PAYMENT_STATUSES.includes(data.status)) {
          setStatus(data.status);
        }
      } catch {
        // Keep the last known status visible if the status request is unavailable.
      }
    };

    refreshStatus();
    timer = window.setInterval(refreshStatus, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [payment?.id, status]);

  const paid = status === 'paid';
  const failed = status === 'failed' || status === 'expired';
  return (
    <div
      className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left"
      data-testid="momo-link-status-fallback"
      role="status"
      aria-live="polite"
    >
      <h2 className="font-bold text-sm text-slate-900">
        {paid ? 'Paiement confirmé' : failed ? 'Paiement échoué' : 'Vérification du paiement en cours'}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-slate-700">
        {paid
          ? 'Le statut a été confirmé côté serveur.'
          : failed
            ? 'Le prestataire indique que le paiement n’a pas abouti. Si votre compte Mobile Money a été débité, contactez le marchand avant de réessayer.'
            : 'Nous vérifions le statut côté serveur. Ne relancez pas le paiement tant que son état n’est pas confirmé.'}
      </p>
    </div>
  );
}