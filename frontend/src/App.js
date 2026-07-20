import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import Landing from '@/pages/Landing';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import PaymentSuccess from '@/pages/PaymentSuccess';
import PaymentCancel from '@/pages/PaymentCancel';
import PublicLink from '@/pages/PublicLink';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import DashboardHome from '@/pages/dashboard/Home';
import Transactions from '@/pages/dashboard/Transactions';
import Links from '@/pages/dashboard/Links';
import ApiKeys from '@/pages/dashboard/ApiKeys';
import Kyc from '@/pages/dashboard/Kyc';
import Settings from '@/pages/dashboard/Settings';
import Support from '@/pages/dashboard/Support';
import Transfer from '@/pages/dashboard/Transfer';
import Deposit from '@/pages/dashboard/Deposit';
import Exchange from '@/pages/dashboard/Exchange';
import '@/App.css';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors closeButton />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/pay/:slug" element={<PublicLink />} />
          <Route path="/payment/success" element={<PaymentSuccess />} />
          <Route path="/payment/cancel" element={<PaymentCancel />} />
          <Route path="/dashboard" element={<Protected><DashboardLayout /></Protected>}>
            <Route index element={<DashboardHome />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="links" element={<Links />} />
            <Route path="api" element={<ApiKeys />} />
            <Route path="kyc" element={<Kyc />} />
            <Route path="settings" element={<Settings />} />
            <Route path="support" element={<Support />} />
            <Route path="transfer" element={<Transfer />} />
            <Route path="deposit" element={<Deposit />} />
            <Route path="exchange" element={<Exchange />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
