import { useEffect } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight, XCircle } from 'lucide-react';
import { useState } from 'react';
import api from '@/api';

export default function PaymentSuccess() {
  const loc = useLocation();
  const nav = useNavigate();
  const params = new URLSearchParams(loc.search);
  const sessionId = params.get('session_id');
  const [status, setStatus] = useState('polling');
  const [data, setData] = useState(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { data } = await api.get(`/payments/status/${sessionId}`);
        if (cancelled) return;
        setData(data);
        if (data.payment_status === 'paid') { setStatus('paid'); return; }
        if (attempts >= 15) { setStatus('timeout'); return; }
        setAttempts((a) => a + 1);
        setTimeout(poll, 2000);
      } catch {
        setStatus('error');
      }
    };
    poll();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [sessionId]);

  return (
    <div className="bt-page min-h-screen flex items-center justify-center p-6">
      <div className="bt-panel max-w-md w-full p-8 sm:p-10 text-center" data-testid="payment-success-page">
        {status === 'polling' && (
          <>
            <div className="mx-auto w-16 h-16 rounded-full border-4 border-blue-100 border-t-[#2563EB] animate-spin" />
            <h1 className="mt-6 font-cabinet text-2xl font-extrabold text-slate-900">Vérification du paiement…</h1>
            <p className="mt-2 text-slate-600 text-sm">Merci de patienter.</p>
          </>
        )}
        {status === 'paid' && (
          <>
            <div className="mx-auto w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="w-9 h-9 text-emerald-500" />
            </div>
            <h1 className="mt-6 font-cabinet text-2xl font-extrabold text-slate-900">Paiement confirmé !</h1>
            <p className="mt-2 text-slate-600">Votre solde a été crédité de <b>{data?.amount?.toLocaleString()} {data?.currency}</b>.</p>
            <button onClick={() => nav('/dashboard')} data-testid="btn-back-dashboard" className="mt-6 inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-6 py-3 rounded-full">
              Retour au tableau de bord <ArrowRight className="w-4 h-4" />
            </button>
          </>
        )}
        {(status === 'timeout' || status === 'error') && (
          <>
            <div className="mx-auto w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
              <XCircle className="w-9 h-9 text-red-500" />
            </div>
            <h1 className="mt-6 font-cabinet text-2xl font-extrabold text-slate-900">En attente</h1>
            <p className="mt-2 text-slate-600 text-sm">Le paiement n&apos;est pas encore confirmé. Réessayez dans quelques instants.</p>
            <Link to="/dashboard" className="mt-6 inline-block text-[#2563EB] font-semibold" data-testid="link-back-dashboard">← Retour au dashboard</Link>
          </>
        )}
      </div>
    </div>
  );
}
