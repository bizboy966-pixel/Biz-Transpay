import { Link } from 'react-router-dom';

const REFERRAL_MESSAGE = 'Parrainez et recevez jusqu’à 2,5 % sur la première transaction de recharge de vos filleuls.';

export default function ReferralBanner() {
  return (
    <Link
      to="/dashboard/profile#referral"
      className="bt-social-banner bt-referral-banner"
      data-testid="referral-banner"
      aria-label={REFERRAL_MESSAGE}
    >
      <span className="bt-referral-banner__viewport" aria-hidden="true">
        <span className="bt-referral-banner__track">
          <span className="bt-referral-banner__message">{REFERRAL_MESSAGE}</span>
          <span className="bt-referral-banner__message">{REFERRAL_MESSAGE}</span>
        </span>
      </span>
    </Link>
  );
}
