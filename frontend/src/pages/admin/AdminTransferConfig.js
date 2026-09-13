import AdminEasyChangeFees from './AdminEasyChangeFees';
import AdminMobileMoneyWithdrawals from './AdminMobileMoneyWithdrawals';

export default function AdminTransferConfig() {
  return (
    <div className="space-y-6">
      <AdminMobileMoneyWithdrawals />
      <AdminEasyChangeFees direction="withdrawal" />
    </div>
  );
}