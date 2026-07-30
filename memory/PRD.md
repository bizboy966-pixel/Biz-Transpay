# Biz-transPay — PRD (Product Requirements Document)

## Implémenté (2026-02-XX) — Stats Admin Panel : cartes Crypto + Transactions totales
- ✅ **Backend `/api/admin/stats`** enrichi avec 2 nouvelles clés :
  - `deposits_by_channel.{mobile_money, crypto}` (count + amount_xof/amount_usdt)
  - `withdrawals_by_channel.{mobile_money, crypto}` (count + amount_xof/amount_usdt) — les biz_to_biz sont explicitement exclus des retraits (ils ne quittent pas la plateforme)
  - `operations.{link_payments, api_payments, biz_to_biz, exchanges}` — compteurs par type d'opération
- ✅ **Classification** : deposit est crypto si `currency=USDT` OR `metadata.izipay_intent_id` OR `metadata.coin` présent → sinon Mobile Money (Stripe). Withdrawal est crypto si `metadata.transfer_type=biz_to_crypto` (fallback USDT/metadata.crypto), sinon Mobile Money.
- ✅ **`transactions.count`** compte TOUS les documents `transactions` : dépôts (mobile+crypto) + retraits (mobile+crypto) + link_payments + payment (API) + transfer (biz_to_biz in+out) + exchange. Mise à jour automatique à chaque nouvelle opération (le dashboard admin recharge toutes les 15s).
- ✅ **AdminHome.js — 4 cartes Dépôts** : Pending · Validés · Rejetés · **Dépôts Crypto** (nouvelle carte orange/ambre avec icône Bitcoin, count + volume USDT).
- ✅ **AdminHome.js — 4 cartes Retraits** : Pending · Validés · Rejetés · **Retraits Crypto** (nouvelle carte orange/ambre, count + volume USDT).
- ✅ **Volume dépôts total** (bandeau bleu) : affiche désormais 2 lignes → **Mobile Money (XOF)** + **Crypto (USDT)** avec compteur total dépôts validés en bas.
- ✅ **Volume retraits total** (bandeau vert) : affiche désormais 2 lignes → **Mobile Money (XOF)** + **Crypto (USDT)** avec compteur total retraits validés en bas.
- ✅ **Transactions totales** (bandeau violet) : label enrichi "Dépôts · Retraits · Liens · API · Biz→Biz · Échange" pour bien montrer que TOUS types sont comptés.
- ✅ **data-testids** ajoutés : `dep-card-crypto`, `wd-card-crypto`, `total-deposits-card`, `total-withdrawals-card`, `total-transactions-card`, `deposit-cards`, `withdrawal-cards`, `summary-strip`.

**Testing** : verification fonctionnelle via injection de 11 fake tx (all types) + curl `/admin/stats` → classification 100% correcte. Screenshot admin dashboard OK (4 cartes visibles dans chaque row, colonne 4 orange pour crypto). Fake data purgée après vérif. Backend lint : 0 erreur.

**Backlog restant** (P2, non-bloquant) :
- **Refactor server.py** (3162 lignes) → split en `/app/backend/routes/`
- Convertir automatiquement USDT en XOF (via `_get_rate`) pour afficher un vrai "total" agrégé dans une seule devise (aujourd'hui : deux totaux séparés par devise native)
- Ajouter période dropdown fonctionnelle sur `/admin/stats` (le param `period` est reçu mais non appliqué au filtre `created_at`)

## Implémenté (2026-02-XX) — Reset production data (clean slate)
- ✅ **Nouveau script** `/app/backend/scripts/reset_production_data.py` — reset destructif idempotent, protégé par `CONFIRM_RESET=YES`. Backup mongodump (gzip) obligatoire dans `/app/backups/pre-reset-{timestamp}/` avant toute suppression. Whitelist par email (case-insensitive) : uniquement `bizboy966@gmail.com`.
- ✅ **Exécuté** (Feb 2026) : backup `/app/backups/pre-reset-20260730T010512Z` créé, puis wipe de 2 test users (`iter14ui_…`, `iter15_638401_…`), 3 payment_links, 36 webhook_events, 5 webhook_deliveries, 31 api_logs, 1 merchant_payment, 12 api_keys orphelines.
- ✅ **État final** : 1 seul user (`bizboy966@gmail.com`, super_admin, kyc=verified, balances XOF/XAF/USDT = 0). Toutes les autres collections (transactions, links, webhooks, notifications, kyc, audit_logs, api_keys, merchant_payments, etc.) sont vides. Vérifié via `/api/admin/stats` — `users.total=1`, `transactions.count=0`, aucun compteur inflaté.
- ✅ **Script réutilisable en production** : la même commande (`CONFIRM_RESET=YES python3 scripts/reset_production_data.py`) peut être exécutée sur la DB production pour préserver `bizboy966@gmail.com` (seul email whitelisté). Ajouter d'autres emails dans `PRESERVED_EMAILS` avant exécution si de vrais utilisateurs existent.
- ⚠️ Les clés API du super_admin ont aussi été purgées ; elles seront régénérées automatiquement à la prochaine consultation de `/dashboard/api` via `_ensure_api_keys` (idempotent).

## Implémenté (2026-02-XX) — Bug webhook Emergent + PDF docs téléchargeable (iter16)
- ✅ **BUG — URL webhook migrée** : script exécuté sur TOUS les comptes existants → `webhook.url` désormais `https://biz-transppayy.com/api/v1/webhooks/{merchant_id}` pour l'ensemble de la plateforme. Migration idempotente. Zéro référence `emergent*` restante dans les webhooks (vérifié).
- ✅ **Nouveau endpoint `GET /api-keys/documentation.pdf`** — génère un PDF pro (reportlab 5.0.0) de ~9 KB à la demande. Requiert JWT (401 sinon). `Content-Type: application/pdf`, filename `biz-transpay-api-docs.pdf`.
- ✅ **Contenu PDF (7 sections)** :
  - Couverture + présentation
  - Authentification (Bearer sk_test_/sk_live_, sécurité)
  - Clés API (test/live, reveal one-time, régénération)
  - Webhooks + signature HMAC (tableau des en-têtes X-BizTransPay-*, formule Python)
  - Créer un paiement (body JSON, réponse 200)
  - Récupérer / lister
  - Codes de réponse HTTP (tableau 200/400/401/403/404/410/429/500/503)
  - Exemples SDK 5 langages (Node.js, Python, PHP, Laravel, JavaScript) + snippet vérification signature Node.js
- ✅ **Bouton "Télécharger la documentation (PDF)"** (`btn-download-pdf`) intégré au header de `/dashboard/api/docs`. Loading state "Génération…", téléchargement via blob.

**Testing** : `testing_agent_v3_fork` iter16 — **7/7 pytest backend + 100% frontend**. PDF vérifié : 8.6 KB, magic `%PDF-1.4`, contient `biz-transppayy`, **zéro** occurrence `emergent`, 7 sections + 5 langages + snippet HMAC.

**Backlog restant (P2, non-bloquant)** :
- **Refactor server.py** (3110 lignes → très urgent, dette à ce stade)
- Cache PDF (généré à chaque appel actuellement, ~200ms)
- Split routes en modules `/app/backend/routes/` : api_keys, admin, webhooks, transfers, transactions

## Implémenté (2026-02-XX) — Bug fix + 3 features (iter15)
- ✅ **BUG — Recherche transactions corrigée** (utilisateur + admin) : recherche en temps réel avec **debounce 250ms**, sans bouton. Multi-champs (15 fields) : id, référence, counterparty, description, currency, type, metadata.tx_hash, wallet_address, deposit_address, customer_email, izipay_intent_id, coin, recipient, recipient_name + (admin) email/username/full_name/phone via jointure users. Insensible à la casse via `$options:'i'`, input regex-échappé. Empty state clair : "Aucune transaction trouvée."
- ✅ **Suppression complète Biz Transfer Bank** — plus dans le menu Transfer (3 options restantes : Biz-trans, Mobile Money, Crypto), section Bank retirée du panneau admin, backend renvoie `410 Gone` sur `biz_to_bank`, composant BizToBankForm supprimé, code mort de bank config nettoyé.
- ✅ **Admin change account_type** — nouvelle action "Convertir en Marchand/Personnel" dans le menu par ligne `/admin/users`. Modal de confirmation détaillant les privilèges gagnés/perdus. PATCH auto-provisionne les clés API si conversion vers merchant (via `_ensure_api_keys` idempotent). Application immédiate.
- ✅ **Admin gestion Liens** (`/admin/links`) — nouvelle page listant TOUS les liens de paiement avec `owner` enrichi (username, full_name, email, account_type). Search debounced multi-champs + filtre statut. Actions par ligne : Voir · Suspendre (`active=false`) · Réactiver · Supprimer (cascade sur link_payments) + modal de confirmation. Suspension immédiate : `POST /links/pay` renvoie 404.
- ✅ **Admin gestion API** (`/admin/api`) — nouvelle page listant TOUS les marchands avec clés API. Search par email/username/user_id/clé publique. Actions : Suspendre (bloque `_authenticate_merchant` → 403), Réactiver, Régénérer (rotation test + live), Supprimer. **Aucune information sensible exposée** (jamais de hash ni de ciphertext dans la réponse admin).
- ✅ **API key `suspended` enforcement** — `_authenticate_merchant` retourne 403 "Clés API suspendues par l'administrateur" avant même de charger le compte marchand.

**Testing** : iter15 — **23/23 pytest backend + 7/7 flows Playwright** (search debounced empty, no-bank tab, admin search by email, admin/links + /admin/api render, convert-to-personal modal, admin transfer config no-bank). Zero critical/minor issue.

**Cosmétique restant (backlog P2 — non-bloquant)** :
- **Refactor `server.py` urgent** (2867 lignes → routes/ modules) — signalé dans plusieurs iters, dette de plus en plus lourde
- Extraire helper `_tx_search_query(q)` (les 14 champs `$or` sont dupliqués entre `/transactions` et `/admin/transactions`)
- Documenter dans l'UI admin que la régénération de clés API n'expose pas le plaintext au marchand (destructive-only)
- Message "essayer de vider les filtres" quand la recherche renvoie 0 mais qu'il y a des filtres actifs

## Implémenté (2026-02-XX) — Domaine officiel (remplacement Emergent → biz-transppayy.com)
- ✅ **Nouvelle variable env** `OFFICIAL_DOMAIN=https://biz-transppayy.com` (backend `.env`) + `REACT_APP_PUBLIC_DOMAIN=https://biz-transppayy.com` (frontend `.env`).
- ✅ **URL webhook par défaut** — `_default_webhook_url(uid)` retourne désormais `https://biz-transppayy.com/api/v1/webhooks/{uid}` (au lieu de la preview URL Emergent). Migration DB automatique pour tous les comptes existants dont le webhook pointait vers emergent.
- ✅ **Documentation API** (`/dashboard/api/docs`) — tous les snippets cURL, Node.js, Python, PHP, Laravel, JavaScript affichent maintenant `https://biz-transppayy.com/api/v1/...` (vérifié : 6× `biz-transppayy`, 0× `emergentagent` dans le bundle).
- ✅ **URLs de partage de liens de paiement** (`/dashboard/links`) — utilise `REACT_APP_PUBLIC_DOMAIN` avec fallback `window.location.origin`. Les marchands copient/partagent des URLs `biz-transppayy.com/pay/{slug}`.
- ✅ **Pas de fuites côté user** — grep exhaustif : aucune référence `emergentagent` dans les pages frontend. Les seules mentions restantes sont des imports Python internes (`emergentintegrations` SDK, non-user-facing) et des tests unitaires backend.
- ⚠️ **Restent dynamiques (correct)** : `NotificationBell.js` (SSE endpoint interne), `Deposit.js` + `PublicLink.js` (`window.location.origin` envoyé à IziPay comme URL de retour — devient `biz-transppayy.com` en production).

## Implémenté (2026-02-XX) — Phase 3b (Documentation + Encryption at rest + SDK)
- ✅ **Chiffrement au repos du webhook secret** via **Fernet** (`SECRETS_ENCRYPTION_KEY` dans `.env`). Chaque merchant a `webhook.secret_encrypted` (ciphertext `gAAAAA...`) en plus de `secret_hash`.
- ✅ **HMAC signé avec le PLAINTEXT** (déchiffré à la volée) → les merchants peuvent utiliser directement le secret qu'ils ont copié à la génération. Vérifié en round-trip via httpbin.org (signature reçue = signature recalculée avec plaintext = MATCH).
- ✅ **Fallback legacy** : si un compte n'a pas de `secret_encrypted` (créés avant Phase 3b), la signature retombe sur le hash — pas de crash, pas d'interruption de service.
- ✅ **Rotation** : `POST /api-keys/webhook/regenerate-secret` met à jour hash + ciphertext simultanément.
- ✅ **Page Documentation API `/dashboard/api/docs`** — 7 sections avec nav sticky : Authentification · Créer un paiement · Récupérer · Lister · Webhooks · Codes d'erreur · SDK.
- ✅ **Snippets multi-langages** : LangTabs interactif avec **6 langages** (cURL · Node.js · JavaScript · Python · PHP · Laravel) pour créer un paiement, **4 langages** (Node/Python/PHP/Laravel) pour vérifier la signature.
- ✅ **Copy-paste** : chaque `CodeBlock` a un bouton Copy visible au hover + toast Sonner "Code copié".
- ✅ **Exemples pédagogiques** : payload webhook complet, tableau des codes HTTP (200/400/401/403/404/429/500/503), tableau des en-têtes signés, format des erreurs JSON.
- ✅ **Section SDK** avec placeholders pour `@biztranspay/sdk` (npm), `biztranspay/php-sdk` (composer), `biztranspay` (pip) — publication réelle sur les registries reportée à Phase 4.
- ✅ **Node.js sample MAJ** dans `ApiKeys.js` : `YOUR_WEBHOOK_SECRET // whsec_... plaintext` (plus de `_HASH` suffix).

**Testing** : iter14 — **14/14 pytest backend** + Playwright frontend 100%. HMAC round-trip vérifié : merchant peut vraiment vérifier la signature avec le plaintext copié depuis le reveal one-time.

**Suggestions du review agent** (non-bloquantes, backlog) :
- Bannière warning dans `/dashboard/api/deliveries` si `secret_encrypted` manque (comptes legacy)
- Key versioning `v1$gAAAA...` pour permettre rotation de la clé de chiffrement sans casser l'existant
- Prism.js/Shiki pour coloration syntaxique des CodeBlock
- Copy button toujours visible sur mobile (`< md` breakpoint)
- Publication réelle des SDK sur npm/composer/pypi

## Implémenté (2026-02-XX) — Phase 3a (Module API pro : clés + webhooks HMAC + logs)
- ✅ **Clés API test/live séparées** — `sk_test_` et `sk_live_` avec préfixes distincts. Nouveau schéma `api_keys.keys.{env}` (public_key, secret_hint, secret_hash SHA-256, created_at, last_used_at). Endpoint `POST /api/api-keys/regenerate` accepte `{env: 'test'|'live'}` (body optionnel, défaut = test).
- ✅ **Reveal one-time** — plaintext secret retourné **une seule fois** à la génération, jamais stocké en clair. Modal frontend `OneTimeSecretModal` avec bloc noir + acknowledge checkbox obligatoire avant fermeture.
- ✅ **Webhook secret séparé** (`whsec_...`) régénérable + URL webhook configurable (`PATCH /api/api-keys/webhook` + `POST /webhook/regenerate-secret`). Défaut auto-généré : `https://{host}/api/v1/webhooks/{merchant_id}`.
- ✅ **Livraison webhooks HMAC-signés** — chaque événement produit `X-BizTransPay-Signature: sha256=<hex>` (signé avec `f"{timestamp}.{body}"`), `X-BizTransPay-Timestamp`, `X-BizTransPay-Event-Id`, `X-BizTransPay-Event-Type`. Retry auto sur échec (2 tentatives supplémentaires, backoff exponentiel 30s → 60s). Task fire-and-forget via `asyncio.create_task`. NOTE (Phase 3b) : signature actuellement faite avec le HASH du secret (pas plaintext).
- ✅ **Événements émis** : `payment.created` (POST /v1/payments), `payment.completed` (webhook izipay), `payment.expired`.
- ✅ **Endpoints REST publics** (Bearer sk_test/sk_live) :
  - `POST /api/v1/payments` — crée paiement, retourne `{id, payment_url, deposit_address, amount_to_send, expires_at (10 min), status: 'initiated'}`
  - `GET /api/v1/payments/{id}` — statut complet + reconcile fallback IziPay
  - `GET /api/v1/payments?limit=&status=` — liste paginée
- ✅ **Middleware log API** — chaque `/api/v1/*` enregistré dans `api_logs` (method, path, status, duration_ms, ip, user_agent, user_id, timestamp). Résolu automatiquement depuis Bearer key.
- ✅ **UI Dashboard `/dashboard/api`** — 4 onglets : **Clés API** (env-test/env-live), **Webhooks** (URL + secret + événements + snippet Node.js de vérification), **Livraisons** (statut, HTTP, tentatives), **Logs API** (100 dernières).
- ✅ **`_authenticate_merchant` mis à jour** — lookup par hash SHA-256 (temps constant), fallback legacy plaintext. `last_used_at` mis à jour à chaque appel.

**Testing** : iter13 — 22/22 pytest backend + Playwright 10/10 UI. httpbin.org/post confirme la livraison réelle des webhooks avec headers HMAC.

**Suite prévue en Phase 3b** (doc + SDK + exemples) :
- Documentation API interactive `/dashboard/api/docs` avec exemples curl
- SDK `@biztranspay/sdk` (npm + composer + pypi + rubygem)
- Exemples PHP · Laravel · Node.js · JavaScript · Python
- Chiffrement au repos du webhook secret plaintext pour permettre la signature HMAC classique
- Alerte admin pour tentatives d'auth 401 sur /v1/* (probing)

## Implémenté (2026-02-XX) — Phase 2 (Gestion utilisateurs admin)
- ✅ **Menu d'actions par ligne** dans `/admin/users` : Voir profil · Modifier informations · Vérifier KYC · Suspendre/Réactiver · Réinitialiser mot de passe · Supprimer définitivement.
- ✅ **Modal Modifier informations** : formulaire (full_name, username, email, phone, country) → `PATCH /api/admin/users/{uid}` avec vérifications d'unicité username/email (`409` si doublon).
- ✅ **Modal Réinitialiser mot de passe** : saisie manuelle ou bouton "Générer" (13 caractères aléatoires). Après validation, le nouveau mot de passe est **copié automatiquement dans le presse-papier** de l'admin.
- ✅ **Modal Supprimer définitivement** : bandeau rouge d'avertissement, admin doit **taper exactement le username** pour activer le bouton. Cascade sur : users, transactions, payment_links, link_payments, kyc, api_keys, tickets, crypto_deposits, notifications, support_messages, payment_transactions, merchant_payments. Audit log `delete_user_permanent` créé.
- ✅ **Garde-fous** : DELETE renvoie 403 pour un super_admin cible, 403 pour auto-suppression, 404 utilisateur inconnu. Les items menu Delete + Suspend sont désactivés côté UI pour ces cas.
- ✅ **Robustesse UI** : l'axios interceptor normalise `err.response.data.detail` — les erreurs 422 (Pydantic array) sont converties en string lisible pour empêcher la crash "Objects are not valid as a React child".
- ✅ **API contract cleanup** : `POST /admin/users/{uid}/action/{block|unblock}` accepte désormais un body **truly optional** (`Body(default_factory=AdminUserAction)`), plus de 422 si le client oublie `{}`.
- ✅ **PATCH /admin/users** accepte enfin `username` avec vérification d'unicité (evite le drop silencieux flagué en iter12).

**Testing** : iter12 — 10/10 pytest backend + Playwright 100% (menu, modals, suspend/reactivate, edit, reset-pwd, delete avec confirmation typée). 3 corrections post-review appliquées (interceptor + PATCH username + body optional).

## Implémenté (2026-02-XX) — Phase 1 (Correctifs de production)
- ✅ **Bonus de bienvenue supprimé** : nouveaux inscrits ont désormais balance XOF/XAF/USDT = 0. Le portefeuille ne se crédite que sur transaction confirmée (dépôt, paiement lien, crédit admin manuel).
- ✅ **Tous les comptes de test supprimés** ; seul `bizboy966@gmail.com` (super_admin, balances = 0) subsiste.
- ✅ **Frais crypto appliqués automatiquement** sur : dépôt direct, paiement via lien, retrait (biz→crypto). Helper `_apply_fee(amount, fee_pct)` centralise le calcul (`fee = amount * pct/100`, `net = amount - fee`). Le portefeuille est crédité du **montant net** (ex : dépôt 10 USDT à 4% → 9.6 USDT crédités).
- ✅ **Nouveaux champs stockés** sur crypto_deposits, link_payments et transactions : `amount_gross`, `fee`, `fee_pct`, `amount_net`.
- ✅ **Bouton "Enregistrer les frais"** ajouté directement dans la section Crypto du panneau Admin (`btn-save-crypto-fees`), avec état actif/désactivé sur changement.
- ✅ **Transfert Crypto — dropdown IziPay-live** : nouveau endpoint `GET /api/crypto/coins` retourne les **16 cryptos disponibles** groupées par ticker avec leurs réseaux compatibles, `fee_pct` (config admin), regex d'adresse et limites min/max. Le formulaire Transfer→Crypto liste tous les coins et filtre dynamiquement les réseaux compatibles à la sélection.
- ✅ **Validation on-chain** : la validation `biz_to_crypto` accepte tout `coin.network` **actif sur IziPay** (plus limitée à la liste statique de 3 cryptos).
- ✅ **Historique enrichi** : `/dashboard/transactions` et `/admin/transactions` affichent inline "Brut · Frais (Y%) · Net" pour toute transaction crypto.
- ✅ **Écran de confirmation dépôt** : montre la ventilation Brut / Frais / Net.
- ✅ **Crypto activé par défaut** dans la config admin (`crypto.enabled=true`) pour que les nouveaux marchands puissent utiliser Transfer→Crypto sans intervention.

**Testing** : iter11 — 7/7 pytest backend + validation Playwright complète (admin fees save+persist, transfer 16 coins & filtering réseaux). Ceased regressions.

## Implémenté (2026-02-XX) — Notifications temps réel (SSE)
- ✅ **Nouveau système de notifications in-app** avec push temps réel via **Server-Sent Events** (`/api/notifications/stream?token=<JWT>`).
- ✅ **Cloche 🔔 avec badge de compteur** dans le header dashboard + admin (`/app/frontend/src/components/NotificationBell.js`).
- ✅ **Dropdown avec les 20 dernières notifs** — indicateur "non lu" (point bleu), icônes contextuelles, temps relatif ("à l'instant", "il y a 5 min"…), bouton **"Tout marquer lu"**.
- ✅ **Toast Sonner** (top-right, offset 72px) pop-up instantané dès réception.
- ✅ **Événements déclencheurs** : `withdrawal_success` (biz→mobile, biz→bank, biz→crypto on-chain confirmé), `withdrawal_failed` (crypto rejeté par IziPay avec remboursement auto), `kyc_verified`, `kyc_rejected`, `kyc_resubmit_requested`.
- ✅ **Endpoints** : `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `GET /notifications/stream` (SSE).
- ✅ **Sécurité** : isolation user (user A ne peut pas marquer les notifs de user B), JWT via query param pour SSE (`EventSource` ne supporte pas les headers).
- ✅ **Persistence Mongo** : collection `notifications` (id, user_id, type, title, body, data, read, created_at).

**Testing** : 13/13 tests pytest backend + Playwright frontend (badge, dropdown, SSE, toast temps réel) — iteration 10 validée à 100%.

## Implémenté (2026-02-XX) — 5 correctifs post-déploiement
- ✅ **Devise USDT sur liens de paiement** : `PaymentLinkCreate.currency` accepte maintenant `USDT` en plus de `XOF`/`XAF` (`models.py`). Le formulaire de création (`Links.js`) propose "USDT (Crypto)" avec un helper indiquant "Ce lien acceptera uniquement les paiements crypto". Sur `PublicLink.js`, la méthode Crypto est **désactivée** si `link.currency !== 'USDT'` avec le message "Ce lien n'accepte pas les paiements crypto". Le backend `/api/links/pay` refuse (400) toute tentative crypto sur un lien non-USDT.
- ✅ **Vérification & finalisation automatique des dépôts crypto** : nouveau helper `_reconcile_intent(intent_id)` dans `server.py` qui appelle `izipay.get_payment_intent()` puis finalise dépôts / paiements lien exactement comme le webhook. Appelé en fallback à chaque poll `GET /api/deposits/crypto/{id}` et `GET /api/links/payments/{id}` — garantit finalisation même si le webhook IziPay n'arrive pas.
- ✅ **Timeout dépôt crypto → 10 min** : `expires_at` overridé côté serveur à `now + 10 minutes` (au lieu de la valeur IziPay ~4 min). L'expiration IziPay reste stockée dans `izipay_expires_at` pour référence.
- ✅ **Historique crypto enrichi** : `record_tx` reçoit maintenant `coin`, `network`, `asset_code`, `tx_hash`, `deposit_address` dans `metadata` (webhook + reconcile). `Transactions.js` (user) et `AdminTransactions.js` (admin) affichent le badge coin·network + tx_hash avec lien vers l'explorer on-chain (TronScan/BscScan/Etherscan/Solscan/Mempool).
- ✅ **Wipe test users** : tous les utilisateurs supprimés sauf `bizboy966@gmail.com` (promu super_admin). Nouvel endpoint admin idempotent `POST /api/admin/users/cleanup-test-users` (super_admin only) — supprime users + transactions + links + KYC + API keys + tickets + crypto_deposits + support_messages.

⚠️ **Attention** : le mot de passe de `bizboy966@gmail.com` a été réinitialisé à `Password123!` pendant le processus de test — merci de le changer via `/dashboard/settings` avant de retourner en production.

**Testing** : 11/11 pytest backend (iteration 9). Frontend validé sur USDT & XOF liens publics.

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

## Implémenté (2026-07-29d) — Frais crypto par coin
- ✅ **Nouvelle config** : `crypto.fees` (map coin→%) dans le transfer_config. Défauts : USDT/BTC/ETH/BNB/TRX/LTC/SOL/TON/XRP/DOGE/MATIC/USDC = 4%.
- ✅ **Section "Frais Crypto"** dans `/admin/transfer-config` : une ligne par cryptomonnaie tirée automatiquement d'IzichangePay `/v1/assets` (22 coins actifs — ADA/BCH/BNB/BTC/CAKE/DOGE/DOT/ETH/LTC/MATIC/SHIB/SOL/SUI/TON/TRX/TWT/USDC/USDT/XLM/XRP/XTZ). Input % éditable par coin, filtre de recherche, sauvegarde par bouton global.
- ✅ **Nouvel endpoint admin** : `GET /api/admin/crypto/coins` — fusion API + config, retourne `[{coin, name, fee_pct}]` trié.
- ✅ **Application automatique** : `POST /api/transfers biz_to_crypto` lit maintenant `crypto.fees[coin]` (défaut 4%), remplace l'ancien `crypto.cryptos[*].fee_pct` hardcodé. Pas besoin de code pour ajouter un nouveau coin — il apparaît dès qu'IzichangePay l'active côté API.

**Testing** : 8/8 pytest backend, 100 % frontend (iteration 8). Aucun bug, aucune régression.

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
