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

## Correctifs (2026-07-29c) — 3 bugs production
- ✅ **Bug A** — Page blanche après clic "Payer maintenant" sur `/dashboard/deposit` corrigé : suppression du hack `window.__crypto_deposit` (global fragile qui cassait en build production), state React proprement lifté via `useState(deposit)` dans le composant parent.
- ✅ **Bug B** — Page blanche après login depuis `/pay/{slug}` corrigé : validé E2E sur preview (public link → logout → /login → /dashboard OK avec dashboard-home rendu).
- ✅ **Bug C** — Bouton "Payer maintenant" invisible sur `/pay/{slug}` : (a) le bouton reste **toujours visible** grâce à `disabled:bg-slate-300 disabled:text-slate-500` (fini `opacity-50` qui pouvait passer inaperçu), (b) le label du champ `refund_address` indique explicitement "(obligatoire)" avec un helper text, (c) toast Sonner sur toute erreur API (fini les échecs silencieux — le message vendor "Adresse de remboursement invalide." s'affiche maintenant clairement).

**Testing** : 7/7 pytest backend, 100 % des flows frontend validés (iteration 7). Aucune régression sur les intégrations existantes (webhook signé, deposit, transfer biz_to_crypto, merchant API).

**⚠️ Attention** : les correctifs sont en preview. Pour que la production `https://biz-transppayy.com` en bénéficie, **il faut redéployer** depuis Emergent.

## Implémenté (2026-07-29b) — Flow crypto IN-APP complet (v2)
- ✅ **Suppression du redirect hosted** — passage à `POST /v1/payment-intents/direct` d'IzichangePay qui retourne directement `depositAddress`, `memo`, `amountToSend`, `expiresAt` sans redirection.
- ✅ **Nouveau `GET /api/crypto/assets`** — catalogue public des 47+ cryptomonnaies actives (USDT, USDC, BTC, ETH, BNB…) avec réseaux (TRC20, BEP20, ERC20, TON, SOL, POLYGON…) proxied depuis IzichangePay, cache 5min. Aucune clé exposée.
- ✅ **Dépôt Crypto — Wizard 3 étapes** (`/dashboard/deposit`) :
    1. **Choix méthode** : Crypto / Mobile Money / Carte
    2. **Formulaire** : nom complet, email, crypto (dropdown depuis /crypto/assets), réseau (boutons), adresse de remboursement, montant
    3. **Écran de paiement** : QR code (qrcode.react), adresse copiable, montant exact, réseau, timer d'expiration, avertissement anti-erreur. **Polling automatique toutes les 4s** → confirmation → écran "Paiement confirmé avec succès" avec refresh du solde.
- ✅ **Lien de paiement crypto** (`/pay/{slug}`) — même Wizard 3 étapes, même expérience client.
- ✅ **Retrait crypto** (`/dashboard/transfer` → Crypto) — ajout des champs Nom complet + Email, payout on-chain via `POST /v1/payouts`, refund automatique en cas d'échec, status pending → confirmed via webhook `payout.confirmed` + tx_hash enregistré.
- ✅ **Sécurité** : validation `min_length=1` sur refund_address/full_name/asset_code/slug (empty strings → 422). Messages d'erreur vendor sanitisés côté serveur (log complet, retour générique côté client).
- ✅ **Webhooks** : réception, vérification HMAC-SHA256, anti-replay 5min, déduplication event_id, dispatch vers dépôts / liens / merchant payments / payouts.

**Testing** : 16/17 pytest passés (iteration 5, 94% backend), 100% frontend (wizard 3 étapes atteint avec QR + adresse Tron réelle + polling actif). Fix du refund_address vide validé (422 au lieu de 200).

## Implémenté (2026-07-29) — Intégration IzichangePay (crypto complet)
- ✅ **Dépôt crypto USDT** — nouveau POST `/api/deposits/crypto` → crée un `payment-intent` IzichangePay, retourne le `payment_url` hosted. Onglet "Crypto" dans /dashboard/deposit avec sélecteurs de réseau (TRC20/BEP20/ERC20).
- ✅ **Transfert biz_to_crypto** — appelle réellement `POST /v1/payouts` (schéma exact : `{assetCode, destinationAddress, amount, merchantReference}`). Débit optimiste + refund automatique en cas de rejet de la passerelle. Status pending → confirmed via webhook.
- ✅ **Lien de paiement crypto** — POST `/api/links/pay` crée un intent IzichangePay et redirige le client vers le checkout hosted. Le marchand est crédité à la confirmation.
- ✅ **API Marchand** — POST `/api/v1/payments` authentifié via `sk_test_/sk_live_` (clé secrète marchand), retourne payment_url. GET `/api/v1/payments/{id}` pour statut.
- ✅ **Webhook signé** — POST `/api/webhooks/izipay` :
    - Vérification HMAC-SHA256 constant-time (via `hmac.compare_digest`)
    - Anti-replay via timestamp signé (max 5 min)
    - Déduplication via index unique `webhook_events.event_id`
    - Dispatch : `payment_intent.completed/expired`, `payout.confirmed/failed`, `settlement.completed`
    - Crédite ou refund les balances selon l'événement
- ✅ **Sécurité clés** — `IZIPAY_API_KEY`, `IZIPAY_WEBHOOK_SECRET`, `IZIPAY_BASE_URL` uniquement dans `/app/backend/.env`. Aucune fuite dans le bundle frontend (vérifié testing agent).
- ✅ **Deep-merge PATCH config** — `PATCH /api/admin/transfer/config` fait maintenant un dot-notation `$set` par sous-clé pour ne pas écraser les tableaux `cryptos`/`networks`/`operators` lors des toggles partiels.
- ✅ **Messages d'erreur clients** — les erreurs vendor (IzichangePay) sont journalisées côté serveur et affichées de façon générique aux utilisateurs (`"Adresse crypto invalide"` au lieu d'exposer le message brut de la passerelle).

**Testing** : 17/17 pytest passés (iteration 4), 100 % backend + 100 % frontend précédemment. Le suite `/app/backend/tests/test_izipay_integration.py` doit être exécuté en séquentiel (`pytest -n 0`).

## Correctifs (2026-07-22b) — Nettoyage Binance + Fix Toggles + USDT card
- ✅ **Binance retiré partout** : Transfer.js, AdminTransferConfig.js, server.py, models.py, DEFAULT_TRANSFER_CONFIG, DB settings. Le module Transfer ne montre plus que 4 options (Biz-to-Biz, Mobile Money, Banque, Crypto).
- ✅ **Toggles Admin Panel corrigés** : les boutons Activer/Désactiver appellent maintenant PATCH immédiatement (auto-save). Ils sont clairement labellés selon l'action à effectuer ("Activer" quand désactivé, "Désactiver" quand activé), avec un badge d'état séparé. S'applique à AdminTransferConfig (Mobile Money, Banque, Crypto) et AdminPlatform (frais de conversion + retraits automatiques).
- ✅ **Cartes wallet uniformes** : les 3 cartes XOF/XAF/USDT ont maintenant exactement la même hauteur (h-[132px] mobile, h-[148px] desktop), même largeur, mêmes marges, mêmes coins arrondis, mêmes ombres. Badge "MULTI-RÉSEAUX" retiré. Testing agent validé : desktop 357×124px, mobile 350×101px pour les 3.

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
