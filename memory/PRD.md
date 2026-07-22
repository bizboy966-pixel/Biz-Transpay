# Biz-transPay — PRD (Product Requirements Document)

## Original problem statement
Créer une passerelle de paiement fintech premium (`Biz-transPay`) avec 3 surfaces :
1. **Landing page** ultra-moderne (nav, hero 3D phone, features, moyens de paiement, stats, sécurité, politique, CTA, footer).
2. **Inscription / Connexion** avec toggle Personnel/Marchand, KYC obligatoire pour Liens & API.
3. **Dashboard marchand** avec sidebar, solde XOF/XAF, actions rapides (Transfer/Dépôt/Lien/Échange), transactions, KYC, API keys, paramètres, support.

Le design doit dépasser Stripe/Flutterwave/Paystack/CinetPay/Moneroo/Lemon Squeezy.

## User personas
- **Marchand** : entrepreneur qui veut encaisser via lien, intégrer l'API, gérer XOF/XAF.
- **Particulier** : utilisateur individuel avec lien de paiement uniquement.

## Architecture
- **Backend** : FastAPI monolithique (`server.py` + `models.py` + `auth.py`), MongoDB (`motor`), JWT auth, Stripe (Flow B `emergentintegrations` — sandbox partagé `sk_test_emergent` car Togo hors SMP).
- **Frontend** : React 19 + React Router 7, TailwindCSS, shadcn/ui, `react-i18next` (FR/EN), `react-fast-marquee`, `sonner` (toasts), `lucide-react` (icônes), Cabinet Grotesk + Plus Jakarta Sans.

## Core requirements (static)
- Auth JWT (email/username + password), inscription avec pays/dial code, bonus de bienvenue 25 000 XOF + 15 000 XAF pour la démo.
- KYC auto-approuvé en démo (submit → verified).
- Transferts biz→biz (0% frais), biz→mobile (1%), biz→banque (1.5%).
- Dépôts Stripe (XOF/XAF → USD approx 1/600).
- Échange XOF↔XAF avec frais 0.5%.
- Liens de paiement (CRUD + slug public `/pay/:slug`).
- API keys (public/secret) + webhook config (marchands uniquement).
- i18n FR + EN.

## Implémenté (2026-02-20)
- ✅ Landing page complète (Navbar sticky-glass, Hero 3D phone + bulles XOF/XAF, 6 features, marquee moyens de paiement, stats animées avec compteurs & avatars, sécurité, politique rouge, CTA bleu, footer).
- ✅ Register (validation, toggle Personnel/Marchand, dial code, robot visuel, terms).
- ✅ Login.
- ✅ Dashboard : sidebar collapsible, topbar glass, 2 cartes de solde bleu-gradient, 4 quick actions pastel, search bar, KYC banner dismissible, activité récente.
- ✅ Transfer 3-step wizard (biz→biz avec crédit destinataire, mobile, banque).
- ✅ Deposit → Stripe Checkout (emergentintegrations Flow B).
- ✅ Payment success page avec polling status.
- ✅ Exchange XOF↔XAF avec swap, taux & frais live.
- ✅ Payment Links (create modal, list, copy, share, toggle, delete, public page).
- ✅ API Keys (view, regen, webhook config, secret mask/show).
- ✅ KYC (submit + auto-approve démo).
- ✅ Settings (profil, mot de passe, 2FA toggle, langue, devise).
- ✅ Support (tickets + FAQ accordion).
- ✅ i18n FR/EN + selecteur navbar + settings.

## Implémenté (2026-07-22) — Portefeuille USDT + Binance + Crypto
- ✅ **Portefeuille USDT** ajouté au Dashboard (3ᵉ carte, dégradé emerald→teal, badge "MULTI-RÉSEAUX", même dimensions/animations que XOF/XAF).
- ✅ **Toggle Masquer/Afficher solde** (persisté dans localStorage) — s'applique à toutes les cartes ET aux montants dans l'activité récente.
- ✅ **Backend** : champ `balance_usdt` ajouté à `UserPublic` + tous les endpoints (`/auth/me`, `/wallet/summary`) + colonne DB (patch appliqué aux utilisateurs existants).
- ✅ **Module Transfer étendu** : 5 options → Biz-to-Biz (avec devise USDT), Mobile Money, Banque, **Binance**, **Crypto**.
- ✅ **Binance Transfer** : formulaire avec Pay ID/Email + montant + frais bearer + récap → si désactivé : bannière "Bientôt disponible."
- ✅ **Biz-trans → Crypto** : sélection Crypto (USDT/BTC/ETH configurable), sélection Réseau (TRC20/BEP20/ERC20/SOLANA/BTC configurable), champ adresse avec **validation regex live** contre le réseau choisi (rejet visuel rouge/vert), frais % + fixes, récap complet, protection anti-erreur.
- ✅ **Admin Panel étendu** (`/admin/transfer-config`) :
    - Section Binance (enable, fee_pct, min, max, note).
    - Section Crypto (enable, table éditable cryptomonnaies avec code/nom/réseaux/frais/limites/actif, table éditable réseaux blockchain avec regex d'adresse, sélecteur des réseaux USDT activés).
- ✅ **Mobile responsive** : toutes les tailles réduites (text-xs/sm, gap-2/3, p-3/4, w-9/w-11 pour icônes) pour smartphones Android.
- ✅ **Validation adresse** : le backend vérifie via regex que l'adresse est compatible avec le réseau choisi avant tout débit.

## Prioritized backlog

### P1 (améliorations importantes)
- Vraie intégration Wave / MTN / Orange Money (aujourd'hui : Stripe seulement pour dépôts).
- Vraie intégration Binance Pay API pour Binance Transfer.
- Vraie exécution on-chain via provider (Circle/Fireblocks) pour biz_to_crypto.
- Dépôts USDT (avec sélection réseau).
- Notifications in-app (bell icon actuellement statique).
- Charts/analytics dans le dashboard (recharts déjà installé).
- Confirmation par email/SMS (Resend / Twilio).

### P2 (finitions)
- reCAPTCHA v3 réel (aujourd'hui : visuel uniquement).
- 2FA avec code TOTP réel (toggle stocké mais pas de vérif OTP).
- Cache Redis pour taux de change.
- Upload d'images KYC vers object storage.
- Complétion i18n EN sur options de select FR (Général/Technique).
- Refactoring `server.py` (fichier volumineux → routes/models split).

## Tests
- Backend : Transfer USDT (biz_to_crypto + biz_to_binance) validé via curl — validation regex adresse ✅, débit correct ✅, frais % + fixes ✅.
- Frontend : Dashboard 3 wallets + toggle masquer, Transfer 5 options, Admin config Binance+Crypto — vérifiés visuellement.

## Next tasks
- (P1) Intégration réelle Binance Pay + provider crypto on-chain.
- (P1) Dépôt USDT via passerelle crypto (avec choix réseau).
- (P1) Ajouter charts d'activité dans le dashboard home avec recharts.
- (P2) Refactorer server.py.
