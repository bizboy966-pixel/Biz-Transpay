# Biz-transPay — PRD (Product Requirements Document)

## Implémenté (2026-02-XX) — Lien de paiement Mobile Money + suppression Carte bancaire
- ✅ **Nouveau endpoint public** `POST /api/links/pay/mobile-money` — accepte `{slug, amount?, full_name, email, country, operator, phone_number, fee_bearer}`. Valide via `deposit_config` (opérateur activé + min/max + devise), crée un `momo_deposit` avec `source="link_payment"` + un `link_payment` `method="mobile_money"`. Déclenche le prompt USSD via FedaPay.
- ✅ **`GET /api/links/payments/{id}`** enrichi — poll FedaPay pour les MoMo pending, met à jour `status` (paid/failed) en fonction du `momo_deposit`.
- ✅ **`_credit_momo_deposit`** étendu — quand `source="link_payment"` : marque le `link_payment` comme paid, incrémente `payment_links.paid_count/total_amount`, enregistre une transaction `link_payment` dans l'historique du marchand.
- ✅ **Frontend `PublicLink.js`** :
  - Supprimé le bouton **Carte bancaire** (référence `CreditCard`, `method-card`, sub "Bientôt disponible")
  - Enlevé "IzichangePay" du footer sécurité ("Paiement sécurisé · Biz-transPay")
  - Ajouté `MoMoLinkForm` (dropdowns pays/opérateur depuis `/deposits/config`, montant si free, preview frais live) + `MoMoLinkTracker` (polling 4s, écrans pending/paid/failed)
  - Le bouton Mobile Money est désormais **actif** et lance le formulaire dédié
- ✅ **Frontend `Deposit.js`** :
  - Supprimé la méthode **Carte bancaire** de `methods[]`
  - Supprimé le composant `CardDepositForm`
  - Supprimé l'import `CreditCard`
  - Il ne reste plus que Crypto + Mobile Money dans le picker

**Testing** (curl + screenshot) :
- Création d'un lien de paiement OK ✅
- Fetch public du lien OK ✅
- `POST /links/pay/mobile-money` avec opérateur invalide → 400 "Opérateur indisponible" ✅
- Screenshot `/dashboard/deposit` confirme méthode Card supprimée, seuls Crypto + Mobile Money visibles ✅
- Backend lint 0 erreur, frontend lint OK (1 warning apostrophe non-bloquant).

**Objectif atteint** : Crypto et Mobile Money 100% opérationnels dans les 3 flux :
- **Dépôts directs** ✅ (Deposit.js → `/deposits/mobile-money` + crypto)
- **Liens de paiement** ✅ (`PublicLink.js` → `/links/pay/crypto` + `/links/pay/mobile-money`)
- **API marchand** ✅ (`/v1/payments` + `/v1/mobile-money/payments`)

## Implémenté (2026-02-XX) — Module API v2 Vague M5 : UI CRUD multi-clés + multi-webhooks
- ✅ **Rewrite complet de `/dashboard/api`** (ApiKeys.js, 500 → 550 lignes) :
  - Onglet **Clés API** — table avec colonnes Nom / Env / Clé publique (copy) / Secret (hint) / Actif toggle / Utilisée / Actions (renommer via prompt, régénérer avec confirm, supprimer). Bouton "+ Créer une clé" → modal (nom + env test/live). Après création : modal "OneTime Secret Reveal" avec checkbox ack + copie one-time.
  - Onglet **Webhooks** — table avec colonnes Nom / URL (truncate + title) / Événements (badge count) / Actif toggle / Échecs / Actions (envoyer test, modifier, régénérer secret, supprimer). Bouton "+ Ajouter un webhook" → modal (nom + URL + événements checkboxes filtrables). Modal réutilisée pour édition.
  - Onglet **Livraisons** — inchangé (montre webhook_deliveries)
  - Onglet **Logs API** — inchangé (montre api_logs)
- ✅ **Composants réutilisables** ajoutés :
  - `OneTimeSecretModal` (checkbox ack obligatoire avant fermeture)
  - `ConfirmModal` (générique avec variante danger rouge)
  - `CreateKeyModal` (nom + env)
  - `WebhookModal` (nom + url + events multi-select, réutilisé create/edit)
- ✅ **Data-testids** ajoutés : `page-api`, `keys-tab`, `webhooks-tab`, `btn-create-key`, `btn-create-webhook`, `create-key-modal`, `webhook-modal`, `key-row-{id}`, `webhook-row-{id}`, `btn-regen-{id}`, `wh-test-{id}`, `wh-delete-{id}`, `wh-event-{ev}`, `input-key-name`, `input-wh-name`, `input-wh-url`, `btn-onetime-close`, `onetime-ack`, `btn-confirm-yes`.

**Testing** : lint 0 erreur, screenshot preview validé (table clés visible avec la clé "Test (migré)" migrée automatiquement, boutons Créer/Renommer/Régénérer/Supprimer présents, tabs fonctionnels, modal Créer une clé s'ouvre correctement).

**Module API v2 complet** :
- Vague M1 (multi-clés backend) ✅
- Vague M2 (multi-webhooks backend + fan-out) ✅
- Vague M3 (API Mobile Money marchand) ✅
- Vague M4 (doc + playground MoMo) ✅
- Vague M5 (UI CRUD complet) ✅

## Implémenté (2026-02-XX) — Module API v2 : Multi-clés + Multi-webhooks + API Mobile Money
- ✅ **Multi clés API** (`db.merchant_keys`) — 1 doc par clé (id, user_id, **name**, env, public_key, secret_hash, secret_hint, **active**, created_at, last_used_at). Migration auto de l'ancien schéma vers "Production (migrée)" + "Test (migré)" au premier appel.
  - Endpoints : `GET /api/merchant/keys`, `POST /api/merchant/keys {name, env}`, `PATCH /api/merchant/keys/{id} {name?, active?}`, `POST /api/merchant/keys/{id}/regenerate`, `DELETE /api/merchant/keys/{id}`
  - `_authenticate_merchant` consulte `merchant_keys` en priorité (avec check `active`), fallback sur schéma legacy — clé désactivée → 403 `API_KEY_DISABLED`.
- ✅ **Multi webhooks** (`db.merchant_webhooks`) — 1 doc par webhook (id, user_id, **name**, url, secret_hash, secret_hint, secret_encrypted, **events[]**, **active**, created_at, last_delivery_at, failure_count).
  - Endpoints : `GET /api/merchant/webhooks` (+ liste des événements dispo), `POST /api/merchant/webhooks {name, url, events[]}`, `PATCH /api/merchant/webhooks/{id}`, `POST /api/merchant/webhooks/{id}/regenerate-secret`, `POST /api/merchant/webhooks/{id}/test` (envoie payment.completed factice), `DELETE /api/merchant/webhooks/{id}`
  - `_deliver_webhook` refactoré en **fan-out** — livre l'événement à TOUS les webhooks actifs qui ont coché ce type d'événement (standard FedaPay/Stripe). Fallback legacy si aucun multi-webhook.
- ✅ **API Mobile Money marchand** :
  - `POST /api/v1/mobile-money/payments` — auth Bearer sk_*, body `{amount, currency, country, operator, customer_email, customer_full_name, customer_phone, reference?, return_url?, description?, metadata?}`. Idempotency-Key supportée. Utilise FedaPay upstream (create + token + send USSD). Respect strict de la config admin (`deposit_config`) : opérateur désactivé → 400 `OPERATOR_DISABLED`, min/max → `AMOUNT_TOO_SMALL/LARGE` avec `details.min/max/currency`.
  - `GET /api/v1/mobile-money/payments/{id}` avec fallback reconcile FedaPay
  - `GET /api/v1/mobile-money/payments?status=…&limit=…` (envelope `{data, count, has_more}`)
  - `GET /api/v1/mobile-money/operators` (auth) — liste filtrée par la config admin
  - Nouveaux événements webhook : `mobile_money.payment.created/approved/declined/canceled/refunded` — fan-out via `_deliver_webhook` sur `transaction.approved/declined/canceled/refunded` de FedaPay (`source="merchant_api"`).
- ✅ **Documentation `/dashboard/api/docs`** : ajout section **"API Mobile Money"** (dans la sidebar entre Récupérer/lister et Webhooks) — endpoint list (GET operators + POST/GET payments), exemple curl complet, exemple JSON response, 4 événements MoMo en cartes couleur. Playground : 2 nouveaux presets ("MoMo opérateurs", "Créer paiement MoMo").
- ✅ **PDF ReportLab** — liste des événements enrichie.

**Testing** (curl end-to-end) :
- Migration auto : legacy → 1 key "Test (migré)" ✅
- Create key "App mobile" → sk_test retourné une fois, utilisable sur `/v1/health` ✅
- Deactivate + delete cycle OK ✅
- Create webhook "Mon serveur crypto" avec events filtrés ✅
- `/v1/mobile-money/operators` → 17 opérateurs (filtered par admin config) ✅
- `POST /v1/mobile-money/payments` avec body invalide → 400 `OPERATOR_UNAVAILABLE`, montant hors range → 400 `AMOUNT_TOO_SMALL` avec `details` ✅
- Backend lint 0 erreur.
- Screenshot doc → section MoMo rendue avec sidebar mise à jour ✅

**⚠️ UI dashboard restant** (P1) : la page `/dashboard/api` (ApiKeys.js) affiche encore l'ancien layout single-key. Les 5 endpoints backend (`GET/POST/PATCH/DELETE/regenerate`) fonctionnent parfaitement mais un CRUD UI n'est pas encore construit. Priorité pour l'itération suivante.

## Implémenté (2026-02-XX) — Config admin des frais de dépôt Mobile Money
- ✅ **Nouveau `deposit_config`** dans `db.settings` (id="deposit_config") — même structure que `transfer_config.mobile_money` mais scopé aux dépôts. Seed par défaut : 17 opérateurs × 8 pays (BJ 3, CI 1, TG 2, SN 1, ML 1, NE 3, BF 2, GN 4). Chaque entrée : `country`, `code`, `name`, **`currency`**, `fee_pct`, `min`, `max`, `active`.
- ✅ **Endpoint public** `GET /api/deposits/config` — expose les opérateurs actifs seulement, groupés par pays (pour le formulaire de dépôt frontend).
- ✅ **Endpoints admin** `GET/PATCH /api/admin/deposit/config` (super_admin) — deep-merge type transfer_config.
- ✅ **Application des frais** — refactorée en 2 points :
  - **Validation à la création** (`POST /api/deposits/mobile-money`) : `_find_deposit_operator(cfg, country, code)` — rejette 400 si opérateur désactivé, valide `min`/`max`, force la devise depuis l'admin.
  - **Crédit du portefeuille** (`_credit_momo_deposit`) : relit `deposit_config` live à chaque webhook `transaction.approved` → `fee_pct` appliqué = valeur admin en temps réel (l'admin peut donc corriger un taux rétroactivement).
- ✅ **Nouvelle page** `/admin/deposit-config` (`AdminDepositConfig.js`) — table éditable pays × opérateur avec colonnes Pays (dropdown 8 pays FedaPay), Code, Nom affiché, Devise (XOF/XAF/GNF/CDF/USD/EUR), Frais %, Min, Max, Actif, Supprimer. Toggle Activer/Désactiver la section entière. Chips résumé par pays. Bouton "Ajouter un opérateur". Enregistrement dirty tracking + toggle instantané.
- ✅ **Sidebar admin** — nouvelle entrée "Config. dépôts" (icône ArrowDownToLine) juste sous "Config. transferts".
- ✅ **Route** `/admin/deposit-config` ajoutée à `App.js`.
- ✅ **Formulaire dépôt utilisateur** (`Deposit.js` MobileMoneyForm) — utilise désormais `/deposits/config` (au lieu de `/fedapay/catalog`), applique la devise/min/max de l'admin dans le validate, affiche un **preview des frais** en direct sous le champ montant (`Frais 1.5% : 15 XOF · Net crédité : 985 XOF`).

**Testing** (curl end-to-end + screenshot admin) :
- `GET /admin/deposit/config` → 17 operators seed ✅
- `GET /deposits/config` → 8 countries × opérateurs (public) ✅
- `PATCH admin` → modifie `fee_pct` de MTN Bénin à 3% → `GET public` reflète 3% immédiatement ✅
- Screenshot admin table : 17 rangées éditables, chips 8 pays, toggle Activer/Désactiver visibles ✅
- Backend lint 0 erreur, frontend lint 2 warnings apostrophes non-bloquants.

**Objectif atteint** : l'admin gère toute la config (frais, min/max, devise, activation) depuis `/admin/deposit-config`. Les valeurs sont appliquées **immédiatement** (pas de redémarrage/redéploiement) à tous les futurs dépôts Mobile Money.

## Implémenté (2026-02-XX) — FedaPay Mobile Money (dépôts + retraits)
- ✅ **Nouveau module** `/app/backend/fedapay.py` — client HTTP FedaPay (create transaction, generate token, send mobile money USSD, create/start payout, verify webhook HMAC). Catalogue statique des 8 pays × opérateurs (BJ/CI/TG/SN/ML/NE/BF/GN, 22 opérateurs mappés vers les codes legacy FedaPay: mtn_open, moov, mtn_ci, moov_tg, togocel, wave_ci, orange_ci, orange_sn, free_sn, mtn_open_gn, moov_gn, wave_gn, orange_gn, moov_bf, sbin, airtel_ml, airtel_ne, wave_ne, orange_ne, moov_ci, celtiis_bj).
- ✅ **Variables .env** : `FEDAPAY_SECRET_KEY`, `FEDAPAY_PUBLIC_KEY`, `FEDAPAY_WEBHOOK_SECRET`, `FEDAPAY_BASE_URL=https://api.fedapay.com/v1` (mode LIVE demandé par l'user).
- ✅ **Nouvel endpoint public** `GET /api/fedapay/catalog` — retourne les 8 pays × opérateurs pour le frontend (Deposit + Transfer).
- ✅ **Dépôt Mobile Money** — `POST /api/deposits/mobile-money` (JWT) : formulaire attendu par l'user (email, nom, pays, opérateur, numéro, montant, fee_bearer). Backend :
  1. Crée la transaction FedaPay (`POST /transactions`)
  2. Génère le token de paiement (`POST /transactions/{id}/token`)
  3. Déclenche le prompt USSD sur le téléphone du client (`POST /transactions/{mode}`)
  4. Retourne `{id, status:"pending", checkout_url (fallback), message}` — le frontend affiche "Vérifiez votre téléphone"
  5. Sur `transaction.approved` (webhook), le portefeuille est crédité (net = montant – 1% marge Biz-transPay), une transaction est enregistrée, une notification est poussée en temps réel.
- ✅ **`GET /api/deposits/mobile-money/{id}`** — polling status + fallback reconcile (poll de FedaPay directement si le webhook tarde).
- ✅ **Retrait Mobile Money** — `POST /api/transfers biz_to_mobile` mis à jour : après le débit optimiste, appelle FedaPay `POST /payouts` + `PUT /payouts/start` avec `merchant_reference=tx.id`. Statut `pending` → `completed` via webhook `payout.sent`, ou refund automatique + notification sur `payout.failed`. Fallback : si l'opérateur n'est pas payout-capable, la transaction reste en pending (traitement manuel admin).
- ✅ **Webhook** `POST /api/webhooks/fedapay` — HMAC-SHA256 vérifié (format `t=<ts>,s=<sig>` ou hex raw), déduplication event_id, dispatche `transaction.approved/canceled/declined/refunded` (dépôts) + `payout.sent/failed/canceled` (retraits).
- ✅ **Frontend Deposit.js** — nouveau composant `MobileMoneyForm` (dropdowns dynamiques pays/opérateur depuis `/fedapay/catalog`, auto-fill email/nom depuis session) + `MobileMoneyTracker` (polling 4s, écrans "Vérifiez téléphone" / "Paiement effectué avec succès" / "Paiement échoué"). Remplace l'écran statique "Bientôt disponible".
- ✅ **Stripe supprimé** du flow Mobile Money (garde-le pour Cartes uniquement, conformément au choix user 2a).
- ✅ **Data-testids** : `momo-deposit-form`, `momo-fullname`, `momo-email`, `momo-country`, `momo-operator`, `momo-phone`, `momo-amount`, `momo-fee-sender`, `momo-fee-receiver`, `momo-submit`, `momo-tracker`.

**Testing** :
- `GET /api/fedapay/catalog` retourne les 8 pays avec 22 opérateurs total ✅
- `POST /api/webhooks/fedapay` sans signature → 400 "Missing webhook signature" ✅
- Screenshot du formulaire Deposit → Mobile Money validé (tous les champs demandés visibles, dropdown pays fonctionnel) ✅
- Backend lint 0 erreur, frontend lint sans problèmes bloquants ✅
- ⚠️ **Test E2E réel non exécuté** (nécessite un vrai numéro Mobile Money + le webhook configuré côté FedaPay dashboard vers `https://biz-transppayy.com/api/webhooks/fedapay`)

**⚠️ À faire côté FedaPay Dashboard AVANT de tester** :
1. Se connecter sur https://app.fedapay.com
2. Onglet Webhooks → ajouter l'URL : `https://biz-transppayy.com/api/webhooks/fedapay`
3. Sélectionner les événements : `transaction.approved`, `transaction.canceled`, `transaction.declined`, `transaction.refunded`, `payout.sent`, `payout.failed`, `payout.canceled`
4. Utiliser le secret webhook fourni (`wh_live_...`)
5. Autoriser le domaine `biz-transppayy.com` pour Checkout.js si utilisé côté navigateur

**⚠️ Sécurité** — les clés LIVE ont été partagées dans le chat. Recommandé de les **régénérer** immédiatement sur le dashboard FedaPay, puis mettre à jour `.env` avec les nouvelles.

## Implémenté (2026-02-XX) — Diagnostic upstream (transparence sur les rejets gateway)
- ✅ **Nouveau `GET /v1/diagnostic`** (auth `sk_test_/sk_live_`) — vérifie l'intégration de bout en bout :
  - `environment` (test/live selon la clé utilisée)
  - `merchant_id`, `account_type`, `kyc_status`
  - `gateway.{configured, reachable, active_coins_count, error}` — bascule vers upstream IziChangePay puis reporte le nombre de crypto actives (ex: 39 en preview) et rien de sensible.
- ✅ **BizAPIError enrichi** — supporte un champ `details` structuré exposé dans la réponse d'erreur normalisée.
- ✅ **Erreur `GATEWAY_REJECTED` transparente** sur `POST /v1/payments` :
  ```json
  {
    "statusCode": 400,
    "message": "Crypto gateway rejected the request: Aucune des cryptos demandées n'est active sur votre compte.",
    "code": "GATEWAY_REJECTED",
    "details": {
      "upstream_status": 400,
      "upstream_code": "unknown",
      "upstream_message": "Aucune des cryptos demandées n'est active sur votre compte.",
      "hint": null
    }
  }
  ```
  Le champ `hint` traduit certains messages upstream courants ("adresse invalide", "montant hors plage", "coin non supporté", "clé passerelle invalide côté serveur").
- ✅ **Nouveau preset Playground** "Diagnostic (auth)" dans `/dashboard/api/docs` — 1 clic pour vérifier son intégration.
- ✅ **Nouvelle section doc** "Health & diagnostic" — schéma de réponse + InfoBox indiquant que si `active_coins_count = 0`, le compte marchand IziChangePay n'a pas encore de crypto activée (à faire contacter le support Biz-transPay).

**Testing** (curl + playground) : `GET /v1/diagnostic` retourne `active_coins_count=39` en preview (gateway upstream OK). `POST /v1/payments` avec `coin=FAKECOIN` retourne 400 `GATEWAY_REJECTED` avec `details.upstream_message = "Aucune des cryptos demandées n'est active sur votre compte."` ✅ Backend lint 0 erreur.

**Objectif** : rendre visible AU MARCHAND (dans Spillover) la vraie raison du rejet upstream, plutôt que le générique "La passerelle crypto a refusé la demande" — pour qu'il puisse fixer son intégration sans devoir contacter le support.

## Implémenté (2026-02-XX) — Module API Phase B : Documentation pro + Playground Try-it
- ✅ **Réécriture complète de `/dashboard/api/docs`** avec sidebar sticky (13 sections), navigation par ancre + scroll-spy actif :
  - Vue d'ensemble (hero + 3 raccourcis vers Try-it / Créer paiement / Webhooks)
  - Base URL & environnements (Production vs Test/Sandbox)
  - Authentification (bearer + warning "ne jamais exposer")
  - Headers communs (tableau exhaustif Authorization / Idempotency-Key / X-RateLimit-*)
  - **Idempotency-Key** (guide + exemple curl round-trip)
  - **Rate limits** (100/min, sliding window)
  - **Format d'erreur & codes** (tableau des 14 codes machine avec sens)
  - **Cycle de vie d'un paiement** (initiated → confirming → completed/failed/expired avec badges couleur)
  - Créer un paiement (5 langages : curl, Node.js, Python, PHP, Laravel) avec Idempotency-Key
  - Récupérer / lister (GET single + list envelope {data, count, has_more})
  - Webhooks & signature HMAC (tableau des 4 headers + verify code 3 langages + 6 événements en cartes couleur)
  - Health check (`GET /v1/health`)
  - **Playground Try-it** (voir ci-dessous)
- ✅ **Nouveau endpoint backend** `POST /api/api-keys/playground` (JWT auth) — proxy interne qui exécute des appels réels sur `/api/v1/*` avec la clé test du marchand (rotée automatiquement à chaque appel, jamais exposée au client). Retourne `{status_code, headers filtrés (content-type, rate-limit, retry-after), body, duration_ms, request}`.
- ✅ **Component Playground** dans `/dashboard/api/docs` :
  - 4 presets cliquables : Health check · Lister paiements · Créer paiement (25 USDT) · Erreur — montant trop petit
  - Editeur libre : Method dropdown, path input, body JSON textarea, Idempotency-Key input
  - Résultat affiché avec badge HTTP couleur (2xx vert, 4xx orange, 5xx rouge) + durée ms
  - Response headers en accordéon `<details>` + body JSON dans un CodeBlock
- ✅ **Amélioration Idempotency** (interne playground) : rotation transparente de la clé test à chaque exécution (via update de secret_hash) — sécurise le flux sans casser la clé publique visible du marchand.
- ✅ **PDF ReportLab mis à jour** — événements liste incluent `payment.confirming`.
- ✅ **Retour au module API** (link ArrowLeft) + bouton **Télécharger PDF** conservés.
- ✅ **Data-testids** : `api-docs-page`, `api-playground`, `playground-method`, `playground-path`, `playground-body`, `playground-idem`, `playground-run`, `playground-response`, `playground-preset-*`.

**Testing** (screenshot preview + curl playground endpoint) : rendu de la sidebar OK, hero OK, section Base URL OK, playground `GET /v1/health` cliqué → HTTP 200 en 3ms avec response headers (X-RateLimit-Limit=100, Remaining=99, Reset=UNIX ts) et body `{status: "ok", version: "1.0.0", ...}` affichés. `POST /v1/payments amount=0.5` → HTTP 400 avec `{code: "AMOUNT_TOO_SMALL"}` correctement rendu. Backend + frontend lint OK (14 warnings apostrophes ESLint non-bloquants, existants avant refonte).

**Restant** :
- Guide "Premier paiement en 5 minutes" (Phase C, séparé — non-bloquant)
- SDK npm/pip publiés (nécessite comptes NPM/PyPI côté user)

## Implémenté (2026-02-XX) — Module API Phase A : Fondations DX (inspiré IziChangePay)
- ✅ **Format d'erreur normalisé** sur toutes les routes `/api/v1/*` → `{statusCode, message, code}` avec codes machine :
  - `MISSING_AUTH_HEADER`, `INVALID_API_KEY_FORMAT`, `INVALID_API_KEY`, `API_KEY_SUSPENDED`, `ACCOUNT_INACTIVE` (auth)
  - `AMOUNT_TOO_SMALL`, `IDEMPOTENCY_KEY_TOO_LONG`, `GATEWAY_UNAVAILABLE`, `GATEWAY_ERROR`, `GATEWAY_REJECTED` (paiement)
  - `PAYMENT_NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR` (générique)
  - Handlers globaux : `HTTPException`, `RequestValidationError`, `Exception` (500)
  - Les routes hors `/api/v1/*` (dashboard, admin) conservent le format legacy `{detail}`
- ✅ **Idempotency-Key** sur `POST /v1/payments` (header optionnel, ≤ 255 caractères) — TTL 24h dans `db.idempotency_keys` avec index unique `(user_id, key)`. Retry identique retourne la même réponse (même `id`), zéro doublon. Round-trip vérifié en test.
- ✅ **Rate limit headers** `X-RateLimit-Limit: 100`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (sliding window 60s par clé, en mémoire). Informatif — pas d'enforcement 429 en Phase A.
- ✅ **`GET /v1/health`** public (aucune auth) → `{status:"ok", version:"1.0.0", timestamp, uptime_seconds}`. Utile pour StatusCake/Uptime Kuma/Grafana Synthetic.
- ✅ **Cycle de vie enrichi** — nouveaux événements webhook :
  - `payment.confirming` (première confirmation on-chain)
  - `payment.failed` (paiement rejeté / montant irrégulier / rollback chaîne)
  - Existants : `payment.created`, `payment.completed`, `payment.expired`
- ✅ **Réponses `/v1/payments*` normalisées** :
  - Montants en string decimal ("42.00", "9999.00")
  - Timestamps ISO 8601 UTC avec suffixe "Z" ("2026-07-30T08:32:17Z")
  - Liste : envelope `{data:[…], count, has_more}` (pagination cursor prête)
- ✅ **Backend lint OK** — 0 erreur.

**Testing** (curl) : 7 scénarios validés
  1. `/v1/health` → 200 avec uptime
  2. POST /v1/payments sans auth → 401 `MISSING_AUTH_HEADER`
  3. POST avec mauvais format clé → 401 `INVALID_API_KEY_FORMAT`
  4. POST avec clé inexistante → 401 `INVALID_API_KEY`
  5. POST amount=0.5 → 400 `AMOUNT_TOO_SMALL`
  6. POST body vide → 422 `VALIDATION_ERROR` "amount: Field required"
  7. GET /v1/payments/nonexistent → 404 `PAYMENT_NOT_FOUND`
  8. Round-trip Idempotency-Key : 2 POST successifs avec même clé → même `id` ✅
  9. Headers `X-RateLimit-*` présents avec clé valide ✅

**Restant pour Phase B** (à venir) :
- Réécriture complète de `/dashboard/api/docs` façon IziChangePay (nav sticky, sections Base URL · Auth · Headers · Idempotency · Cycle de vie · Codes machine · Webhooks + tableaux exhaustifs)
- **Playground "Try-it"** intégré dans la doc — exécute des appels réels via la clé du marchand
- Mise à jour PDF (ReportLab) pour matcher le nouveau format
- Guide "Premier paiement en 5 minutes"

## Implémenté (2026-02-XX) — Reset plateforme depuis Admin Panel (self-service)
- ✅ **Nouveau endpoint** `POST /api/admin/platform/reset` (super_admin only) — accepte `{"confirmation": "RÉINITIALISER"}` (case-sensitive, sinon 400). Supprime : tous les non-super_admin users + `transactions`, `payment_links`, `link_payments`, `crypto_deposits`, `webhook_events`, `webhook_deliveries`, `api_logs`, `notifications`, `tickets`, `support_messages`, `payment_transactions`, `merchant_payments`, `kyc`, `audit_logs`, `api_keys`. Remet à zéro les soldes des super_admins. Re-provisionne automatiquement les clés API des super_admin restants (via `_ensure_api_keys`). Audit log recréé.
- ✅ **Nouvelle "Zone de danger"** en bas de `/admin/platform` — encart rouge avec bouton `btn-open-platform-reset`. Modal de confirmation qui exige à l'admin de **taper exactement `RÉINITIALISER`** (fonte monospace) pour activer le bouton `btn-confirm-platform-reset`. État "Réinitialisation…" avec spinner pendant l'opération. Toast succès/erreur.
- ✅ **Test end-to-end** (preview) : injection user+tx+link fake → reset avec confirmation vide → 400 (message d'erreur clair) → reset avec `RÉINITIALISER` → 1 user supprimé, 1 tx wipée, 1 link wipé, soldes super_admin à 0. Post-reset : `users.total=1`, `transactions.count=0`. ✅
- ⚠️ **Production** : le bouton apparaîtra en production après redéploiement depuis Emergent. L'admin peut alors cliquer "Réinitialiser" → taper `RÉINITIALISER` → tout est nettoyé en <1s (backup Mongo non inclus dans l'endpoint — utiliser le script `reset_production_data.py` si un backup est requis avant).

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


## 2026-08-03 — API publique Biz-Transpay v1 (Crypto Pay-In)
Rewrite complet du module API public, remplaçant l'ancien bloqué (410 Gone).

### Fonctionnement
- Merchant → **API Biz-Transpay** (clés `sk_test_` / `sk_live_`) → Backend → IziChange (interne).
- Aucun webhook — les marchands **pollent** `/status`. Le backend synchronise en background avec IziChange pour garantir la fraîcheur.
- L'intégration existante `izipay.py` reste inchangée (réutilisation only).

### Endpoints (base : `${REACT_APP_BACKEND_URL}/api/v1`)
- `POST /payments` — Créer un paiement crypto (retourne `id`, `status`, `payment_url`, `expires_at`)
- `GET /payments/{id}` — Détails complets + sync auto
- `GET /payments/{id}/status` — Statut léger `{id, status, updated_at}`
- `GET /payments/{id}/completed` — Booléen `{completed, status}`
- `POST /payments/{id}/cancel` — Annuler (409 si déjà `paid`, idempotent)
- `GET /payments/search?reference=…` — Recherche par référence marchand
- `GET /payments?limit&offset&status&reference` — Liste paginée
- `GET /health` — Public health check

### Sécurité & fiabilité
- Auth Bearer `sk_test_` / `sk_live_` (SHA-256 hash côté serveur)
- Idempotency-Key (fenêtre 24 h, replay = même réponse)
- Rate limit 100 req/min/clé (`X-RateLimit-*` headers)
- Format d'erreur normalisé `{statusCode, message, code, details?}`

### CRUD Clés (dashboard, JWT) — `/api/merchant/keys`
- Créer, lister, régénérer, désactiver, supprimer.
- **Reveal one-time** : la clé secrète pleine n'est affichée qu'à la création. Le back n'en garde qu'un hash.

### Frontend
- `/dashboard/api` — page de gestion des clés (hero, table, modal reveal ack-gated, quick start).
- `/dashboard/api/docs` — documentation style Stripe/Paystack : sidebar sticky 3 groupes / 17 sections, LangTabs 7 langages (cURL, JS, Node, PHP, Python, Java, C#), tableau des statuts/erreurs, FAQ, ZÉRO section webhooks.

### Testing
- 20/20 backend + frontend E2E (iteration_17.json), aucun bug identifié.

## 2026-08-03 — API publique Biz-Transpay v1 — Retraits (Payouts)
Extension du module API public avec les retraits crypto, en réutilisant `izipay.create_payout()` et `izipay.get_payout()` existants (intégration IziChange non modifiée).

### Fonctionnement
- Merchant → **API Biz-Transpay** → Backend → IziChange (interne).
- Débit atomique du solde `balance_usdt`, forwardé à IziChange, remboursé si refus.
- Sync auto en background via `_reconcile_payout` (fetch + update + refund sur nouveau `failed`).
- Aucun webhook — polling only.

### Nouveaux endpoints (`${REACT_APP_BACKEND_URL}/api/v1/payouts`)
- `POST /payouts` — Créer un retrait (validations : solde, min/max, regex adresse, doublon)
- `GET /payouts` — Liste paginée + filtres `status`, `reference`
- `GET /payouts/search?reference=…` — Recherche par référence marchand
- `GET /payouts/{id}` — Détails complets + sync auto
- `GET /payouts/{id}/status` — Statut léger `{id, status, updated_at}`
- `GET /payouts/{id}/completed` — Booléen `{completed, status}`

### Statuts payout
`pending` → `processing` → `sent` → `completed` (terminal ✅) / `failed` (remboursé) / `canceled` (remboursé)

### Nouveaux codes d'erreur
`INSUFFICIENT_BALANCE`, `WITHDRAWALS_BLOCKED`, `INVALID_ASSET`, `INVALID_DESTINATION_ADDRESS`, `AMOUNT_TOO_LARGE`, `GATEWAY_INSUFFICIENT_FUNDS`, `GATEWAY_UNREACHABLE`, `PAYOUT_NOT_FOUND`, `INVALID_FEE_BEARER`.

### Frontend
- `/dashboard/api` — Quick-start passe à 3 cards (Encaisser / Retirer / Suivi).
- `/dashboard/api/docs` — Nouveau groupe sidebar "RETRAITS" (5 sections), 7 langages, tableau params, tableau statuts, FAQ enrichie (3 questions retraits).

### Testing
- 12/12 backend pytest pass (iteration_18.json)
- Frontend complet vérifié : sidebar RETRAITS, 8 codes erreur, 6 statuts, 7 langages, ZÉRO webhook.
- Refund flow validé : solde marchand restauré après refus IziChange (sandbox pas de fonds).

