import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Users, Smartphone, ArrowLeft, CheckCircle2, Clock, ShieldCheck, AtSign, Phone, Info, Bitcoin, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/hooks/useFeatures';
import { COUNTRIES } from '@/constants/countries';
import { CountryBadge, OperatorLogo } from '@/components/PaymentBrand';
import SelectionMenu from '@/components/SelectionMenu';
import TurnstileWidget, { useTurnstileConfig } from '@/components/TurnstileWidget';

export default function Transfer() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { refresh, user } = useAuth();
  const turnstile = useTurnstileConfig();
  const features = useFeatures();
  const [step, setStep] = useState(1);
  const [type, setType] = useState(null);
  const [config, setConfig] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get('/transfer/config').then(({ data }) => setConfig(data)).catch(() => {});
  }, []);

  const opts = useMemo(() => {
    // Mobile Money withdrawal requires at least one FCFA wallet + its
    // withdrawal toggle to be on.
    const mmOn = (
      (features?.wallet_xof_enabled !== false && features?.withdrawal_xof_enabled !== false)
      || (features?.wallet_xaf_enabled !== false && features?.withdrawal_xaf_enabled !== false)
    );
    const providerAvailable = config?.mobile_money?.enabled === true
      && (config?.mobile_money?.operators || []).some((operator) => operator.active === true);
    const cryptoOn = features?.wallet_crypto_enabled !== false && features?.withdrawal_crypto_enabled !== false;
    return [
      { v: 'biz_to_biz', I: Users, c: 'bg-blue-50 text-[#2563EB]', l: 'Biz-trans → Biz-trans', d: 'Instantané · Sans frais', enabled: true },
      { v: 'biz_to_mobile', I: Smartphone, c: 'bg-emerald-50 text-emerald-600', l: 'Biz-trans → Mobile Money', d: 'Vers un numéro Mobile Money', enabled: mmOn && providerAvailable },
      { v: 'biz_to_crypto', I: Bitcoin, c: 'bg-orange-50 text-orange-600', l: 'Biz-trans → Crypto', d: 'USDT · BTC · ETH · Multi-réseaux', enabled: cryptoOn },
    ].filter((o) => o.enabled);
  }, [features, config]);

  const onDone = (data, meta) => {
    setDone({ ...data, meta });
    setStep(3);
    refresh();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-4 sm:space-y-5" data-testid="page-transfer">
      <button onClick={() => step > 1 ? setStep(step - 1) : nav('/dashboard')} className="inline-flex items-center gap-2 text-[11px] sm:text-xs font-semibold text-slate-600 hover:text-[#2563EB]" data-testid="btn-back">
        <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> {t('common.back')}
      </button>

      <div>
        <h1 className="font-cabinet text-xl sm:text-2xl md:text-3xl font-extrabold tracking-tighter text-slate-900">Nouveau transfert</h1>
        <p className="text-slate-500 text-xs sm:text-sm mt-1">Choisissez le type de transfert que vous souhaitez effectuer.</p>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2">
        {[1, 2, 3].map((s) => (
          <div key={s} className={`flex-1 h-1 rounded-full ${step >= s ? 'bg-[#2563EB]' : 'bg-slate-200'}`} />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-2.5 sm:space-y-3">
          {opts.map((o) => (
            <button key={o.v} onClick={() => { setType(o.v); setStep(2); }} data-testid={`transfer-type-${o.v}`} className="w-full bg-white border border-slate-100 rounded-2xl p-3 sm:p-4 flex items-center gap-2.5 sm:gap-3 hover:border-[#2563EB] hover:-translate-y-0.5 transition-all text-left">
              <div className={`w-9 h-9 sm:w-11 sm:h-11 rounded-xl ${o.c} flex items-center justify-center shrink-0`}><o.I className="w-4 h-4 sm:w-5 sm:h-5" strokeWidth={1.75} /></div>
              <div className="flex-1 min-w-0">
                <div className="font-cabinet font-bold text-xs sm:text-sm text-slate-900 truncate">{o.l}</div>
                <div className="text-[10px] sm:text-xs text-slate-500 truncate">{o.d}</div>
              </div>
              <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 shrink-0" />
            </button>
          ))}
        </div>
      )}

      {step === 2 && type === 'biz_to_biz' && <BizToBizForm onDone={onDone} balance={user} turnstile={turnstile} />}
      {step === 2 && type === 'biz_to_mobile' && <BizToMobileForm config={config} onDone={onDone} balance={user} turnstile={turnstile} />}
      {step === 2 && type === 'biz_to_crypto' && <BizToCryptoForm config={config} onDone={onDone} balance={user} turnstile={turnstile} />}

      {step === 3 && done && (
        <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-8 text-center" data-testid="transfer-success">
          <div className="mx-auto w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-emerald-50 flex items-center justify-center"><CheckCircle2 className="w-6 h-6 sm:w-7 sm:h-7 text-emerald-500" /></div>
          <h2 className="mt-3 sm:mt-4 font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">
            {done.pending_manual ? 'Transfert en attente' : 'Transfert effectué !'}
          </h2>
          <div className="mt-2 sm:mt-3 font-cabinet text-2xl sm:text-3xl font-extrabold text-[#2563EB]">
            {done.transaction.amount.toLocaleString()} <span className="text-sm sm:text-base text-slate-500">{done.transaction.currency}</span>
          </div>
          <div className="mt-1 text-xs sm:text-sm text-slate-500 truncate">→ {done.recipient?.full_name || done.transaction.counterparty}</div>
          <div className="mt-1 text-[10px] sm:text-[11px] text-slate-400 font-mono">{done.transaction.reference}</div>
          {done.pending_manual && (
            <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] sm:text-xs text-amber-800">{done.message}</div>
          )}
          {done.fee > 0 && (
            <div className="mt-3 text-[11px] sm:text-xs text-slate-500 space-y-0.5">
              <div>Frais : <b>{done.fee.toLocaleString(undefined, { maximumFractionDigits: 4 })} {done.transaction.currency}</b></div>
              {done.recipient_gets != null && <div>Le bénéficiaire reçoit : <b>{done.recipient_gets.toLocaleString(undefined, { maximumFractionDigits: 4 })} {done.transaction.currency}</b></div>}
            </div>
          )}
          <div className="mt-4 sm:mt-5 flex gap-2 justify-center">
            <button onClick={() => { setStep(1); setDone(null); }} className="px-4 sm:px-5 py-2 sm:py-2.5 rounded-full border border-slate-200 text-[11px] sm:text-xs font-semibold" data-testid="btn-new-transfer">Nouveau transfert</button>
            <button onClick={() => nav('/dashboard')} data-testid="btn-tr-done" className="bg-[#2563EB] text-white font-bold px-4 sm:px-5 py-2 sm:py-2.5 rounded-full text-[11px] sm:text-xs">Terminer</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------- BIZ TO BIZ -------
function BizToBizForm({ onDone, balance, turnstile }) {
  const turnstileRef = useRef(null);
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('XOF');
  const [description, setDescription] = useState('');
  const [recipient, setRecipient] = useState(null);
  const [lookupErr, setLookupErr] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  const lookup = async () => {
    setLookupErr(null); setRecipient(null);
    const q = username.trim() || phone.trim();
    if (!q) return;
    try {
      const { data } = await api.get('/users/lookup', { params: { q } });
      setRecipient(data);
    } catch { setLookupErr('Bénéficiaire Biz-transPay introuvable'); }
  };

  const amt = parseFloat(amount) || 0;
  const bal = balance ? (balance[`balance_${currency.toLowerCase()}`] || 0) : 0;
  const canSubmit = recipient && amt > 0 && amt <= bal && turnstileToken;

  const submit = async () => {
    if (!turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setPending(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: 'biz_to_biz', recipient: username || phone,
        recipient_phone: phone, amount: amt, currency, description,
        turnstile_token: turnstileToken,
      });
      onDone(data, { type: 'biz_to_biz' });
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      toast.error(err.response?.data?.detail || 'Erreur');
    }
    finally { setPending(false); }
  };

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-2.5 sm:p-3 flex items-start gap-2 sm:gap-2.5">
        <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#2563EB] mt-0.5 shrink-0" />
        <div className="text-[11px] sm:text-xs text-slate-700"><b>Instantané · Sans frais.</b> Le bénéficiaire reçoit immédiatement le montant.</div>
      </div>

      <Field label="Nom d'utilisateur du bénéficiaire">
        <div className="relative">
          <AtSign className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input data-testid="b2b-username" value={username} onChange={(e) => { setUsername(e.target.value); setRecipient(null); }} onBlur={lookup} placeholder="bizboy" className="w-full pl-8 sm:pl-9 pr-3 sm:pr-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </div>
      </Field>

      <Field label="Numéro de téléphone (optionnel)">
        <div className="relative">
          <Phone className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input data-testid="b2b-phone" value={phone} onChange={(e) => { setPhone(e.target.value); setRecipient(null); }} onBlur={lookup} placeholder="+228 …" className="w-full pl-8 sm:pl-9 pr-3 sm:pr-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </div>
      </Field>

      {recipient && (
        <div className="p-2.5 sm:p-3 bg-emerald-50 border border-emerald-100 rounded-xl flex items-center gap-2.5 sm:gap-3" data-testid="b2b-recipient-preview">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-[11px] sm:text-xs">{recipient.full_name?.[0]?.toUpperCase() || 'U'}</div>
          <div className="flex-1 min-w-0">
            <div className="text-xs sm:text-sm font-semibold text-slate-900 truncate">{recipient.full_name}</div>
            <div className="text-[10px] sm:text-xs text-emerald-700">Bénéficiaire vérifié · @{recipient.username}</div>
          </div>
          <CheckCircle2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />
        </div>
      )}
      {lookupErr && <div className="text-[11px] sm:text-xs text-red-600">{lookupErr}</div>}

      <div className="grid grid-cols-[1fr_auto] gap-2 sm:gap-3">
        <Field label="Montant">
          <input data-testid="b2b-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10000" min="1" className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
          <div className="mt-1 text-[9px] sm:text-[10px] text-slate-500">Solde : {bal.toLocaleString()} {currency}</div>
        </Field>
        <Field label="Devise">
          <select data-testid="b2b-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-2.5 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl font-semibold text-xs sm:text-sm">
            <option value="XOF">XOF</option><option value="XAF">XAF</option><option value="USDT">USDT</option>
          </select>
        </Field>
      </div>

      <Field label="Description (optionnel)">
        <input data-testid="b2b-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
      </Field>

      <TurnstileWidget
        ref={turnstileRef}
        siteKey={turnstile.siteKey}
        action="withdrawal"
        disabled={turnstile.loading || !turnstile.enabled}
        onToken={setTurnstileToken}
      />
      {turnstileToken && (
        <button disabled={!canSubmit} onClick={() => setConfirmOpen(true)} data-testid="btn-b2b-continue" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-50">
          Continuer
        </button>
      )}

      {confirmOpen && recipient && (
        <ConfirmModal onClose={() => setConfirmOpen(false)} testId="b2b-confirm-modal" rows={[
          ['Bénéficiaire', `${recipient.full_name} (@${recipient.username})`],
          ['Montant', `${amt.toLocaleString()} ${currency}`, 'strong'],
          ['Frais', '0 (gratuit)', 'green'],
          ['Total débité', `${amt.toLocaleString()} ${currency}`, 'strong'],
          ['Le bénéficiaire reçoit', `${amt.toLocaleString()} ${currency}`, 'green'],
        ]} onConfirm={submit} pending={pending} canConfirm={Boolean(turnstileToken)} confirmTestId="btn-b2b-confirm" />
      )}
    </div>
  );
}

// ------- BIZ TO MOBILE -------
function BizToMobileForm({ config, onDone, balance, turnstile }) {
  const turnstileRef = useRef(null);
  const operators = useMemo(
    () => (config?.mobile_money?.operators || []).filter((operator) => operator.active === true),
    [config],
  );
  const countries = useMemo(() => Array.from(new Set(operators.map((operator) => operator.country).filter(Boolean))), [operators]);
  const mmEnabled = config?.mobile_money?.enabled === true && operators.length > 0;
  const [country, setCountry] = useState('');
  const [operator, setOperator] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [feeBearer, setFeeBearer] = useState('sender');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => window.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  useEffect(() => {
    if (!country || !countries.includes(country)) setCountry(countries[0] || '');
  }, [countries, country]);
  const countryOps = useMemo(
    () => operators.filter((o) => o.country === country),
    [operators, country],
  );
  useEffect(() => { setOperator(countryOps[0]?.code || ''); }, [countryOps]);
  const op = countryOps.find((o) => o.code === operator);

  const amt = parseFloat(amount) || 0;
  // Currency is a property of the configured operator. It must not be
  // user-selectable because XOF and XAF balances are not interchangeable.
  const currency = op?.currency || '';
  const feePct = Number(op?.fee_pct) || 0;
  const feeFixed = Number(op?.fee_fixed) || 0;
  const fee = Math.round(amt * feePct / 100 + feeFixed);
  const totalDebit = feeBearer === 'sender' ? amt + fee : amt;
  const recipientGets = feeBearer === 'sender' ? amt : amt - fee;
  const bal = balance ? (balance[`balance_${currency.toLowerCase()}`] || 0) : 0;
  const min = Number(op?.min) || 100;
  const max = op?.max === '' || op?.max == null ? 10 ** 12 : (Number(op.max) || 10 ** 12);
  const canSubmit = op && currency && phone && amt >= min && amt <= max
    && recipientGets > 0 && totalDebit <= bal && turnstileToken;

  const submit = async () => {
    if (!turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setPending(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: 'biz_to_mobile', recipient: phone, country, operator,
        fee_bearer: feeBearer, amount: amt, currency, description,
        idempotency_key: idempotencyKey,
        turnstile_token: turnstileToken,
      });
      onDone(data, { type: 'biz_to_mobile' });
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      const status = err.response?.status;
      if (status >= 400 && status < 500 && status !== 408) {
        setIdempotencyKey(window.crypto?.randomUUID?.()
          || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      }
      toast.error(err.response?.data?.detail || 'Erreur');
    }
    finally { setPending(false); }
  };

  if (!mmEnabled) return <SoonBanner text="Cette fonctionnalité sera activée prochainement." />;

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <Field label="Pays">
        <select data-testid="mm-country" value={country} onChange={(e) => setCountry(e.target.value)} tabIndex="-1" aria-hidden="true" className="sr-only">
          <option value="">Sélectionnez un pays</option>
          {countries.map((countryCode) => {
            const configured = operators.find((o) => o.country === countryCode);
            const known = COUNTRIES.find((c) => c.code === countryCode);
            return <option key={countryCode} value={countryCode}>{configured?.country_label || known?.name || countryCode}</option>;
          })}
        </select>
        <SelectionMenu
          value={country}
          onChange={setCountry}
          placeholder="Sélectionner"
          testId="mm-country-picker"
          options={countries.map((countryCode) => {
            const configured = operators.find((o) => o.country === countryCode);
            const known = COUNTRIES.find((c) => c.code === countryCode);
            return {
              value: countryCode,
              label: configured?.country_label || known?.name || countryCode,
              code: countryCode,
              flag: known?.flag || '🌐',
            };
          })}
          renderValue={(option) => <CountryBadge code={option.code} label={option.label} />}
          renderOption={(option) => <CountryBadge code={option.code} label={option.label} />}
        />
      </Field>

      <Field label="Opérateur Mobile Money">
        {countryOps.length === 0 ? (
          <div className="p-2.5 sm:p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] sm:text-xs text-amber-800">Aucun opérateur disponible pour ce pays pour l&apos;instant.</div>
        ) : (
          <>
            <div className="relative">
              <select data-testid="mm-operator" value={operator} onChange={(e) => setOperator(e.target.value)} disabled={!country || countryOps.length === 0} tabIndex="-1" aria-hidden="true" className="sr-only">
                <option value="">Sélectionnez un opérateur</option>
                {countryOps.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
              </select>
              <SelectionMenu
                value={operator}
                onChange={setOperator}
                placeholder="Sélectionner"
                testId="mm-operator-picker"
                disabled={!country || countryOps.length === 0}
                options={countryOps.map((o) => ({
                  value: o.code,
                  label: o.name || o.code,
                  operator: o,
                }))}
                renderValue={(option) => (
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                    <span className="truncate">{option.label}</span>
                  </span>
                )}
                renderOption={(option) => (
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <OperatorLogo operator={option.operator.code} name={option.label} country={country} size="sm" />
                    <span className="truncate">{option.label}</span>
                  </span>
                )}
              />
            </div>
          </>
        )}
      </Field>

      <Field label="Numéro Mobile Money du bénéficiaire">
        <input data-testid="mm-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={COUNTRIES.find((c) => c.code === country)?.dial + ' 90 00 00 00'} className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 sm:gap-3">
        <Field label="Montant">
          <input data-testid="mm-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5000" min={min} max={max} className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
          {op && <div className="mt-1 text-[9px] sm:text-[10px] text-slate-500">Min {min.toLocaleString()} · Max {op.max === '' || op.max == null ? 'illimité' : max.toLocaleString()} · Solde : {bal.toLocaleString()} {currency}</div>}
        </Field>
        <div className="flex items-end">
          <div className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl bg-slate-50 text-xs sm:text-sm font-semibold text-slate-700" data-testid="mm-currency">
            Devise : {currency || '—'}
          </div>
        </div>
      </div>

      <FeeBearerSwitch value={feeBearer} onChange={setFeeBearer} />

      {op && amt > 0 && (
        <div className="p-3 sm:p-4 bg-slate-50 rounded-xl space-y-1 sm:space-y-1.5 text-xs sm:text-sm" data-testid="mm-summary">
          <Row l="Frais" v={`${fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency} (${feePct}%${feeFixed > 0 ? ` + ${feeFixed} fixe` : ''})`} />
          <Row l="Total débité" v={`${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} strong />
          <Row l="Le bénéficiaire reçoit" v={`${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`} green />
        </div>
      )}

      <TurnstileWidget
        ref={turnstileRef}
        siteKey={turnstile.siteKey}
        action="withdrawal"
        disabled={turnstile.loading || !turnstile.enabled}
        onToken={setTurnstileToken}
      />
      {turnstileToken && (
        <button disabled={!canSubmit} onClick={() => setConfirmOpen(true)} data-testid="btn-mm-continue" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-50">
          Continuer
        </button>
      )}

      {confirmOpen && (
        <ConfirmModal onClose={() => setConfirmOpen(false)} testId="mm-confirm-modal" rows={[
          ['Opérateur', op?.name],
          ['Numéro', phone],
          ['Montant envoyé', `${amt.toLocaleString()} ${currency}`, 'strong'],
          ['Frais', `${fee.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency} (${feePct}%${feeFixed > 0 ? ` + ${feeFixed} fixe` : ''})`],
          ['Frais payés par', feeBearer === 'sender' ? 'Vous' : 'Le bénéficiaire'],
          ['Total débité', `${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`, 'strong'],
          ['Le bénéficiaire reçoit', `${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${currency}`, 'green'],
        ]} onConfirm={submit} pending={pending} canConfirm={Boolean(turnstileToken)} confirmTestId="btn-mm-confirm" />
      )}
    </div>
  );
}

// ------- BIZ TO CRYPTO -------
function BizToCryptoForm({ config, onDone, balance, turnstile }) {
  const turnstileRef = useRef(null);
  const ccfg = config?.crypto || { enabled: false };
  const [coins, setCoins] = useState([]);
  const [loadingCoins, setLoadingCoins] = useState(true);
  useEffect(() => {
    setLoadingCoins(true);
    api.get('/crypto/coins')
      .then(({ data }) => setCoins(data || []))
      .catch(() => setCoins([]))
      .finally(() => setLoadingCoins(false));
  }, []);
  const [cryptoCode, setCryptoCode] = useState('');
  useEffect(() => {
    if (!cryptoCode && coins.length > 0) setCryptoCode(coins[0].coin);
  }, [coins, cryptoCode]);
  const crypto = coins.find((c) => c.coin === cryptoCode);
  const availableNets = crypto?.networks || [];
  const [networkCode, setNetworkCode] = useState('');
  useEffect(() => {
    setNetworkCode(availableNets[0]?.code || '');
    /* eslint-disable-next-line */
  }, [cryptoCode, coins]);
  const network = availableNets.find((n) => n.code === networkCode);

  const [fullName, setFullName] = useState(balance?.full_name || '');
  const [email, setEmail] = useState(balance?.email || '');
  const [walletAddress, setWalletAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [feeBearer, setFeeBearer] = useState('sender');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  // Live address validation
  const addressValidation = useMemo(() => {
    if (!walletAddress || !network?.address_regex) return { ok: null, msg: '' };
    try {
      const re = new RegExp(network.address_regex);
      return re.test(walletAddress.trim())
        ? { ok: true, msg: `Adresse compatible avec ${network.name}` }
        : { ok: false, msg: `Adresse invalide pour ${network.name}` };
    } catch { return { ok: null, msg: '' }; }
  }, [walletAddress, network]);

  const amt = parseFloat(amount) || 0;
  const feePct = crypto?.fee_pct || 4;
  const feeFixed = parseFloat(crypto?.gateway_fee_fixed) || 0;
  const fee = amt * feePct / 100 + feeFixed;
  const totalDebit = feeBearer === 'sender' ? amt + fee : amt;
  const recipientGets = feeBearer === 'sender' ? amt : amt - fee;

  // Human-readable fee label. Hides internal gateway/platform split; only
  // shows "1 USDT + 2.5%" style breakdown when a fixed fee is configured.
  const feeLabel = feeFixed > 0
    ? `${feeFixed} ${cryptoCode} + ${feePct}%`
    : `${feePct}%`;

  // For crypto, currency = crypto code (e.g. USDT). Balance is looked up on user object.
  const currency = cryptoCode || 'USDT';
  const bal = balance ? (balance[`balance_${currency.toLowerCase()}`] || 0) : 0;
  const min = network?.min || 0, max = network?.max || 10 ** 12;
  // Address is valid when either (a) a regex matched OR (b) no regex is
  // configured for this network → we cannot validate client-side, so accept
  // any non-empty value (backend does the definitive check).
  const addressOk = !!walletAddress && (addressValidation.ok !== false);
  const canSubmit = crypto && network && addressOk && amt >= min && amt <= max
    && totalDebit <= bal && fullName && email && turnstileToken;

  // Human-readable list of what's still missing, shown when the button is disabled.
  const missing = [];
  if (!crypto) missing.push('cryptomonnaie');
  if (!network) missing.push('réseau');
  if (!walletAddress) missing.push('adresse du portefeuille');
  else if (addressValidation.ok === false) missing.push('adresse valide');
  if (!(amt >= min)) missing.push(`montant ≥ ${min}`);
  if (amt > max) missing.push(`montant ≤ ${max}`);
  if (amt > 0 && totalDebit > bal) missing.push('solde suffisant');
  if (!fullName) missing.push('nom complet');
  if (!email) missing.push('email');

  const submit = async () => {
    if (!turnstileToken) {
      toast.error('Veuillez terminer la vérification anti-bot.');
      return;
    }
    setPending(true);
    try {
      const { data } = await api.post('/transfers', {
        transfer_type: 'biz_to_crypto', recipient: walletAddress,
        recipient_name: fullName,
        crypto: cryptoCode, network: networkCode, wallet_address: walletAddress,
        fee_bearer: feeBearer, amount: amt, currency, description,
        turnstile_token: turnstileToken,
      });
      onDone(data, { type: 'biz_to_crypto' });
    } catch (err) {
      setTurnstileToken('');
      turnstileRef.current?.reset();
      toast.error(err.response?.data?.detail || 'Erreur');
    }
    finally { setPending(false); }
  };

  if (!ccfg.enabled) return <SoonBanner text="Les transferts crypto seront disponibles prochainement." />;
  if (loadingCoins) return <div className="bg-white border border-slate-100 rounded-2xl p-8 text-center text-xs sm:text-sm text-slate-500">Chargement des cryptomonnaies…</div>;
  if (coins.length === 0) return <SoonBanner text="Aucune cryptomonnaie disponible pour le moment." />;

  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 sm:p-6 space-y-3 sm:space-y-4">
      <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 sm:p-3 flex items-start gap-2 sm:gap-2.5">
        <Bitcoin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-orange-600 mt-0.5 shrink-0" />
        <div className="text-[11px] sm:text-xs text-slate-700"><b>Transfert on-chain.</b> Vérifiez soigneusement le réseau et l&apos;adresse. Les erreurs sont irréversibles.</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
        <Field label="Nom complet">
          <input data-testid="crypto-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Votre nom" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </Field>
        <Field label="Adresse e-mail">
          <input data-testid="crypto-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@email.com" required className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        </Field>
      </div>

      <Field label="Cryptomonnaie">
        <select
          data-testid="crypto-select"
          value={cryptoCode}
          onChange={(e) => setCryptoCode(e.target.value)}
          className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm bg-white"
        >
          {coins.map((c) => {
            const fx = parseFloat(c.gateway_fee_fixed) || 0;
            const feeStr = fx > 0 ? `${fx} ${c.coin} + ${c.fee_pct}%` : `${c.fee_pct}%`;
            return (
              <option key={c.coin} value={c.coin} data-testid={`crypto-opt-${c.coin}`}>
                {c.coin} — {c.name} · frais {feeStr}
              </option>
            );
          })}
        </select>
      </Field>

      <Field label="Réseau blockchain">
        {availableNets.length === 0 ? (
          <div className="p-2.5 sm:p-3 bg-amber-50 border border-amber-100 rounded-xl text-[11px] sm:text-xs text-amber-800">Aucun réseau disponible pour cette cryptomonnaie.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {availableNets.map((n) => (
              <button key={n.code} type="button" onClick={() => setNetworkCode(n.code)} data-testid={`network-${n.code}`}
                className={`p-2 sm:p-3 rounded-xl border text-left transition-colors ${networkCode === n.code ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900">{n.code}</div>
                <div className="text-[9px] sm:text-[10px] text-slate-500 truncate">{n.name}</div>
              </button>
            ))}
          </div>
        )}
      </Field>

      <Field label="Adresse du portefeuille bénéficiaire">
        <input data-testid="crypto-address" value={walletAddress} onChange={(e) => setWalletAddress(e.target.value)} placeholder={network?.code === 'TRC20' ? 'T…' : network?.code?.startsWith('BEP') || network?.code === 'ERC20' ? '0x…' : 'Adresse blockchain'} className={`w-full px-3 sm:px-4 py-2.5 sm:py-3 border rounded-xl outline-none text-xs sm:text-sm font-mono ${addressValidation.ok === false ? 'border-red-300 focus:border-red-500' : addressValidation.ok ? 'border-emerald-300 focus:border-emerald-500' : 'border-slate-200 focus:border-[#2563EB]'}`} />
        {addressValidation.msg && (
          <div className={`mt-1 text-[10px] sm:text-xs font-semibold ${addressValidation.ok ? 'text-emerald-600' : 'text-red-600'}`}>{addressValidation.msg}</div>
        )}
      </Field>

      <Field label={`Montant (${cryptoCode})`}>
        <input data-testid="crypto-amount" type="number" step="0.0001" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" min={min} max={max} className="w-full px-3 sm:px-4 py-2.5 sm:py-3 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-xs sm:text-sm" />
        <div className="mt-1 text-[9px] sm:text-[10px] text-slate-500">Min {min} · Max {max.toLocaleString()} · Solde : {bal.toLocaleString()} {cryptoCode}</div>
      </Field>

      <FeeBearerSwitch value={feeBearer} onChange={setFeeBearer} />

      {amt > 0 && crypto && (
        <div className="p-3 sm:p-4 bg-slate-50 rounded-xl space-y-1 sm:space-y-1.5 text-xs sm:text-sm" data-testid="crypto-summary">
          <Row l="Réseau" v={network?.name || networkCode} />
          <Row l="Montant envoyé" v={`${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`} />
          <Row l="Frais appliqués" v={`${fee.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode} (${feeLabel})`} />
          <Row l="Total débité de votre solde" v={`${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`} strong />
          <Row l="Montant final reçu par le bénéficiaire" v={`${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`} green />
        </div>
      )}

      <TurnstileWidget
        ref={turnstileRef}
        siteKey={turnstile.siteKey}
        action="withdrawal"
        disabled={turnstile.loading || !turnstile.enabled}
        onToken={setTurnstileToken}
      />
      {turnstileToken && (
        <button disabled={!canSubmit} onClick={() => setConfirmOpen(true)} data-testid="btn-crypto-continue" className="w-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold py-3 sm:py-3.5 rounded-xl text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed">
          {canSubmit ? 'Continuer' : (missing.length ? `Renseigner : ${missing.join(', ')}` : 'Continuer')}
        </button>
      )}

      {confirmOpen && (
        <ConfirmModal onClose={() => setConfirmOpen(false)} testId="crypto-confirm-modal" rows={[
          ['Cryptomonnaie', `${cryptoCode} · ${network?.name || networkCode}`],
          ['Adresse', walletAddress, 'mono'],
          ['Montant envoyé', `${amt.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`, 'strong'],
          ['Frais', `${fee.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`],
          ['Frais payés par', feeBearer === 'sender' ? 'Vous' : 'Le bénéficiaire'],
          ['Total débité', `${totalDebit.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`, 'strong'],
          ['Le bénéficiaire reçoit', `${recipientGets.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cryptoCode}`, 'green'],
        ]} onConfirm={submit} pending={pending} canConfirm={Boolean(turnstileToken)} confirmTestId="btn-crypto-confirm" />
      )}
    </div>
  );
}

function SoonBanner({ text }) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-6 sm:p-10 text-center" data-testid="soon-banner">
      <div className="mx-auto w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-amber-50 flex items-center justify-center"><Clock className="w-6 h-6 sm:w-7 sm:h-7 text-amber-500" /></div>
      <h2 className="mt-3 sm:mt-4 font-cabinet text-lg sm:text-xl font-extrabold text-slate-900">Bientôt disponible</h2>
      <p className="mt-2 text-xs sm:text-sm text-slate-500">{text}</p>
      <div className="mt-3 sm:mt-4 inline-flex items-center gap-2 text-[10px] sm:text-[11px] text-slate-500 bg-slate-50 border border-slate-100 rounded-full px-3 py-1">
        <Info className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> Cette fonctionnalité sera activée par un administrateur.
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[11px] sm:text-xs font-semibold text-slate-700 mb-1 sm:mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function FeeBearerSwitch({ value, onChange }) {
  return (
    <Field label="Qui supporte les frais ?">
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onChange('sender')} data-testid="fee-sender" className={`p-2 sm:p-3 rounded-xl border-2 text-left transition-colors ${value === 'sender' ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200'}`}>
          <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900">L&apos;expéditeur paie</div>
          <div className="text-[9px] sm:text-[10px] text-slate-500">Vous payez les frais en plus</div>
        </button>
        <button type="button" onClick={() => onChange('receiver')} data-testid="fee-receiver" className={`p-2 sm:p-3 rounded-xl border-2 text-left transition-colors ${value === 'receiver' ? 'border-[#2563EB] bg-blue-50' : 'border-slate-200'}`}>
          <div className="font-cabinet font-bold text-[11px] sm:text-xs text-slate-900">Le bénéficiaire paie</div>
          <div className="text-[9px] sm:text-[10px] text-slate-500">Frais déduits du montant reçu</div>
        </button>
      </div>
    </Field>
  );
}

function ConfirmModal({ onClose, rows, onConfirm, pending, canConfirm = true, testId, confirmTestId }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl p-4 sm:p-6 max-w-md w-full" data-testid={testId}>
        <h3 className="font-cabinet font-bold text-base sm:text-lg mb-2 sm:mb-3">Récapitulatif</h3>
        <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
          {rows.map(([l, v, kind], i) => (
            <Row key={i} l={l} v={v} strong={kind === 'strong'} green={kind === 'green'} mono={kind === 'mono'} />
          ))}
        </div>
        <div className="mt-4 sm:mt-5 flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 sm:px-4 py-1.5 sm:py-2 rounded-full border border-slate-200 font-semibold text-[11px] sm:text-xs">Annuler</button>
          {canConfirm && (
            <button onClick={onConfirm} disabled={pending} data-testid={confirmTestId} className="px-4 sm:px-5 py-1.5 sm:py-2 rounded-full bg-[#2563EB] text-white font-bold text-[11px] sm:text-xs disabled:opacity-60">{pending ? '…' : 'Transférer'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ l, v, strong, green, mono }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-slate-500 text-[11px] sm:text-xs shrink-0">{l}</span>
      <span className={`${strong ? 'font-bold text-slate-900' : ''} ${green ? 'text-emerald-600 font-bold' : ''} ${mono ? 'font-mono break-all' : ''} text-[11px] sm:text-xs text-right`}>{v}</span>
    </div>
  );
}
