import { Link } from 'react-router-dom';
import { XCircle } from 'lucide-react';

export default function PaymentCancel() {
  return (
    <div className="bt-page min-h-screen flex items-center justify-center p-6">
      <div className="bt-panel max-w-md w-full p-8 sm:p-10 text-center" data-testid="payment-cancel-page">
        <div className="mx-auto w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
          <XCircle className="w-9 h-9 text-red-500" />
        </div>
        <h1 className="mt-6 font-cabinet text-2xl font-extrabold text-slate-900">Paiement annulé</h1>
        <p className="mt-2 text-slate-600">Aucun montant n&apos;a été prélevé.</p>
        <Link to="/dashboard/deposit" data-testid="link-retry-deposit" className="mt-6 inline-block bg-[#2563EB] text-white font-bold px-6 py-3 rounded-full">Réessayer</Link>
      </div>
    </div>
  );
}
