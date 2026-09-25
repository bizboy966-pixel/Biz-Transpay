import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import Landing from '@/pages/Landing';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import RecoverAccount from '@/pages/RecoverAccount';
import RequestPasswordReset from '@/pages/RequestPasswordReset';
import ResetPassword from '@/pages/ResetPassword';
import PaymentSuccess from '@/pages/PaymentSuccess';
import PaymentCancel from '@/pages/PaymentCancel';
import PublicLink from '@/pages/PublicLink';
import DashboardLayout from '@/pages/dashboard/DashboardLayout';
import DashboardHome from '@/pages/dashboard/Home';
import Transactions from '@/pages/dashboard/Transactions';
import Links from '@/pages/dashboard/Links';
import Kyc from '@/pages/dashboard/Kyc';
import Fees from '@/pages/dashboard/Fees';
import Settings from '@/pages/dashboard/Settings';
import Support from '@/pages/dashboard/Support';
import Transfer from '@/pages/dashboard/Transfer';
import Deposit from '@/pages/dashboard/Deposit';
import Exchange from '@/pages/dashboard/Exchange';
import Services from '@/pages/dashboard/Services';
import Integration from '@/pages/dashboard/integration/Integration';
import IntegrationDocs from '@/pages/dashboard/integration/IntegrationDocs';
import Profile from '@/pages/dashboard/Profile';
import AdminLayout from '@/pages/admin/AdminLayout';
import AdminHome from '@/pages/admin/AdminHome';
import AdminUsers from '@/pages/admin/AdminUsers';
import AdminUserDetail from '@/pages/admin/AdminUserDetail';
import AdminKyc from '@/pages/admin/AdminKyc';
import AdminTransactions from '@/pages/admin/AdminTransactions';
import AdminLogs from '@/pages/admin/AdminLogs';
import AdminAdmins from '@/pages/admin/AdminAdmins';
import AdminLinks from '@/pages/admin/AdminLinks';
import AdminTransferConfig from '@/pages/admin/AdminTransferConfig';
import AdminDepositConfig from '@/pages/admin/AdminDepositConfig';
import AdminSupport from '@/pages/admin/AdminSupport';
import AdminFeatures from '@/pages/admin/AdminFeatures';
import AdminRates from '@/pages/admin/AdminRates';
import AdminFees from '@/pages/admin/AdminFees';
import AdminBenefits from '@/pages/admin/AdminBenefits';
import AdminPaymentProviders from '@/pages/admin/AdminPaymentProviders';
import AdminFunds from '@/pages/admin/AdminFunds';
import AdminEmailNotifications from '@/pages/admin/AdminEmailNotifications';
import AdminLegacyCleanup from '@/pages/admin/AdminLegacyCleanup';
import ReauthGate from '@/components/ReauthGate';
import '@/App.css';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Chargement…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin' && user.role !== 'super_admin') return <Navigate to="/dashboard" replace />;
  return children;
}

function AdminHomeEntry() {
  const { user } = useAuth();
  const landingByRole = {
    SUPPORT: '/admin/support',
    COMPLIANCE: '/admin/kyc',
    FINANCE: '/admin/transactions',
  };
  const landing = landingByRole[user?.effective_role];
  if (landing) return <Navigate to={landing} replace />;
  return <AdminHome />;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors closeButton offset={72} />
        <ReauthGate />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/recover" element={<RequestPasswordReset />} />
          <Route path="/recover/mfa" element={<RecoverAccount />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/pay/:slug" element={<PublicLink />} />
          <Route path="/payment/success" element={<PaymentSuccess />} />
          <Route path="/payment/cancel" element={<PaymentCancel />} />
          <Route path="/integration/docs" element={<IntegrationDocs />} />
          <Route path="/dashboard" element={<Protected><DashboardLayout /></Protected>}>
            <Route index element={<DashboardHome />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="links" element={<Links />} />
            <Route path="kyc" element={<Kyc />} />
            <Route path="fees" element={<Fees />} />
            <Route path="settings" element={<Settings />} />
            <Route path="support" element={<Support />} />
            <Route path="transfer" element={<Transfer />} />
            <Route path="deposit" element={<Deposit />} />
            <Route path="services" element={<Services />} />
            <Route path="profile" element={<Profile />} />
            <Route path="exchange" element={<Exchange />} />
            <Route path="integration" element={<Integration />} />
          </Route>
          <Route path="/admin" element={<AdminOnly><AdminLayout /></AdminOnly>}>
            <Route index element={<AdminHomeEntry />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="users/:id" element={<AdminUserDetail />} />
            <Route path="kyc" element={<AdminKyc />} />
            <Route path="links" element={<AdminLinks />} />
            <Route path="transactions" element={<AdminTransactions />} />
            <Route path="deposits" element={<AdminTransactions filterType="deposit" />} />
            <Route path="withdrawals" element={<AdminTransactions filterType="withdrawal" />} />
            <Route path="logs" element={<AdminLogs />} />
            <Route path="admins" element={<AdminAdmins />} />
            <Route path="transfer-config" element={<AdminTransferConfig />} />
            <Route path="deposit-config" element={<AdminDepositConfig />} />
            <Route path="support" element={<AdminSupport />} />
            <Route path="email-notifications" element={<AdminEmailNotifications />} />
            <Route path="features" element={<AdminFeatures />} />
            <Route path="rates" element={<AdminRates />} />
            <Route path="fees" element={<AdminFees />} />
            <Route path="benefits" element={<AdminBenefits />} />
             <Route path="payment-providers" element={<AdminPaymentProviders />} />
             <Route path="funds" element={<AdminFunds />} />
              <Route path="maintenance/legacy-merchant-api" element={<AdminLegacyCleanup />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
