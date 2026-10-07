import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { lazy, Suspense, useEffect } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { pageLoaders } from '@/pageLoaders';
import ReauthGate from '@/components/ReauthGate';
import '@/App.css';

const DashboardLayout = lazy(pageLoaders.dashboardLayout);
const AdminLayout = lazy(pageLoaders.adminLayout);
const PushOptInPrompt = lazy(pageLoaders.pushOptInPrompt);
const Landing = lazy(pageLoaders.landing);
const Login = lazy(pageLoaders.login);
const Register = lazy(pageLoaders.register);
const RecoverAccount = lazy(pageLoaders.recoverAccount);
const RequestPasswordReset = lazy(pageLoaders.requestPasswordReset);
const ResetPassword = lazy(pageLoaders.resetPassword);
const PaymentSuccess = lazy(pageLoaders.paymentSuccess);
const PaymentCancel = lazy(pageLoaders.paymentCancel);
const PublicLink = lazy(pageLoaders.publicLink);
const DashboardHome = lazy(pageLoaders.dashboardHome);
const Transactions = lazy(pageLoaders.transactions);
const Links = lazy(pageLoaders.links);
const Kyc = lazy(pageLoaders.kyc);
const Fees = lazy(pageLoaders.fees);
const Settings = lazy(pageLoaders.settings);
const Support = lazy(pageLoaders.support);
const Transfer = lazy(pageLoaders.transfer);
const Deposit = lazy(pageLoaders.deposit);
const Exchange = lazy(pageLoaders.exchange);
const Services = lazy(pageLoaders.services);
const Integration = lazy(pageLoaders.integration);
const IntegrationDocs = lazy(pageLoaders.integrationDocs);
const Profile = lazy(pageLoaders.profile);
const AdminHome = lazy(pageLoaders.adminHome);
const AdminUsers = lazy(pageLoaders.adminUsers);
const AdminUserDetail = lazy(pageLoaders.adminUserDetail);
const AdminKyc = lazy(pageLoaders.adminKyc);
const AdminTransactions = lazy(pageLoaders.adminTransactions);
const AdminLogs = lazy(pageLoaders.adminLogs);
const AdminAdmins = lazy(pageLoaders.adminAdmins);
const AdminLinks = lazy(pageLoaders.adminLinks);
const AdminTransferConfig = lazy(pageLoaders.adminTransferConfig);
const AdminDepositConfig = lazy(pageLoaders.adminDepositConfig);
const AdminSupport = lazy(pageLoaders.adminSupport);
const AdminFeatures = lazy(pageLoaders.adminFeatures);
const AdminRates = lazy(pageLoaders.adminRates);
const AdminFees = lazy(pageLoaders.adminFees);
const AdminBenefits = lazy(pageLoaders.adminBenefits);
const AdminPaymentProviders = lazy(pageLoaders.adminPaymentProviders);
const AdminFunds = lazy(pageLoaders.adminFunds);
const AdminStatistics = lazy(pageLoaders.adminStatistics);
const AdminEmailNotifications = lazy(pageLoaders.adminEmailNotifications);
const AdminNotifications = lazy(pageLoaders.adminNotifications);
const AdminLegacyCleanup = lazy(pageLoaders.adminLegacyCleanup);

function RouteLoading() {
  return (
    <div
      className="flex min-h-[35vh] items-center justify-center gap-3 text-sm text-slate-500"
      role="status"
      aria-live="polite"
    >
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-[#2563EB]" />
      <span>Affichage de la page…</span>
    </div>
  );
}

function lazyPage(Page) {
  return <Suspense fallback={<RouteLoading />}><Page /></Suspense>;
}

function AuthenticatedPushOptInPrompt() {
  const { user } = useAuth();
  if (!user) return null;
  return <Suspense fallback={null}><PushOptInPrompt /></Suspense>;
}

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

function ForegroundPushToasts() {
  useEffect(() => {
    const handler = (event) => {
      if (event.detail?.title) toast(event.detail.title, { description: event.detail.body, action: event.detail.url ? { label: 'Ouvrir', onClick: () => { window.location.href = event.detail.url; } } : undefined });
    };
    window.addEventListener('btp-foreground-push', handler);
    return () => window.removeEventListener('btp-foreground-push', handler);
  }, []);
  return null;
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

function AdminDepositsEntry() {
  return <AdminTransactions filterType="deposit" />;
}

function AdminWithdrawalsEntry() {
  return <AdminTransactions filterType="withdrawal" />;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors closeButton offset={72} />
        <ForegroundPushToasts />
        <AuthenticatedPushOptInPrompt />
        <ReauthGate />
        <Routes>
          <Route path="/" element={lazyPage(Landing)} />
          <Route path="/login" element={lazyPage(Login)} />
          <Route path="/register" element={lazyPage(Register)} />
          <Route path="/recover" element={lazyPage(RequestPasswordReset)} />
          <Route path="/recover/mfa" element={lazyPage(RecoverAccount)} />
          <Route path="/reset-password" element={lazyPage(ResetPassword)} />
          <Route path="/pay/:slug" element={lazyPage(PublicLink)} />
          <Route path="/payment/success" element={lazyPage(PaymentSuccess)} />
          <Route path="/payment/cancel" element={lazyPage(PaymentCancel)} />
          <Route path="/integration/docs" element={lazyPage(IntegrationDocs)} />
          <Route path="/dashboard" element={<Protected>{lazyPage(DashboardLayout)}</Protected>}>
            <Route index element={lazyPage(DashboardHome)} />
            <Route path="transactions" element={lazyPage(Transactions)} />
            <Route path="links" element={lazyPage(Links)} />
            <Route path="kyc" element={lazyPage(Kyc)} />
            <Route path="fees" element={lazyPage(Fees)} />
            <Route path="settings" element={lazyPage(Settings)} />
            <Route path="support" element={lazyPage(Support)} />
            <Route path="transfer" element={lazyPage(Transfer)} />
            <Route path="deposit" element={lazyPage(Deposit)} />
            <Route path="services" element={lazyPage(Services)} />
            <Route path="profile" element={lazyPage(Profile)} />
            <Route path="exchange" element={lazyPage(Exchange)} />
            <Route path="integration" element={lazyPage(Integration)} />
          </Route>
          <Route path="/admin" element={<AdminOnly>{lazyPage(AdminLayout)}</AdminOnly>}>
            <Route index element={lazyPage(AdminHomeEntry)} />
            <Route path="users" element={lazyPage(AdminUsers)} />
            <Route path="users/:id" element={lazyPage(AdminUserDetail)} />
            <Route path="kyc" element={lazyPage(AdminKyc)} />
            <Route path="links" element={lazyPage(AdminLinks)} />
            <Route path="transactions" element={lazyPage(AdminTransactions)} />
            <Route path="deposits" element={lazyPage(AdminDepositsEntry)} />
            <Route path="withdrawals" element={lazyPage(AdminWithdrawalsEntry)} />
            <Route path="logs" element={lazyPage(AdminLogs)} />
            <Route path="admins" element={lazyPage(AdminAdmins)} />
            <Route path="transfer-config" element={lazyPage(AdminTransferConfig)} />
            <Route path="deposit-config" element={lazyPage(AdminDepositConfig)} />
            <Route path="support" element={lazyPage(AdminSupport)} />
            <Route path="email-notifications" element={lazyPage(AdminEmailNotifications)} />
            <Route path="notifications" element={lazyPage(AdminNotifications)} />
            <Route path="features" element={lazyPage(AdminFeatures)} />
            <Route path="rates" element={lazyPage(AdminRates)} />
            <Route path="fees" element={lazyPage(AdminFees)} />
            <Route path="benefits" element={lazyPage(AdminBenefits)} />
            <Route path="payment-providers" element={lazyPage(AdminPaymentProviders)} />
            <Route path="funds" element={lazyPage(AdminFunds)} />
            <Route path="statistics" element={lazyPage(AdminStatistics)} />
            <Route path="maintenance/legacy-merchant-api" element={lazyPage(AdminLegacyCleanup)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
