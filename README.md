# Biz-transPay

Application de paiement full-stack :

- frontend React 19 / CRACO ;
- backend Python 3.12 / FastAPI / Uvicorn ;
- MongoDB avec Motor ;
- intégrations PayDunya, FedaPay, IzichangePay, Mbiyo et Telegram.

## Déploiement sur Emergent

Le dépôt conserve l'organisation native attendue par Emergent :

```text
frontend/   application React
backend/    application FastAPI et requirements.txt
.emergent/  configuration de l'environnement Emergent
```

### 1. Import

1. Placer ce dépôt dans un dépôt GitHub privé.
2. Dans Emergent, connecter GitHub puis importer le dépôt et la branche.
3. Conserver MongoDB comme base de données. Ne pas convertir en MySQL.
4. Configurer les variables backend à partir de `backend/.env.example`.
5. Configurer les variables frontend à partir de `frontend/.env.example`.
6. Ne jamais committer les fichiers `.env` réels.

### 2. Commandes

Backend :

```bash
python -m pip install -r backend/requirements.txt
bash scripts/start-emergent-backend.sh
```

Frontend :

```bash
cd frontend
yarn install --frozen-lockfile
yarn build
```

Pour une Preview Emergent qui attend un serveur de développement frontend :

```bash
cd frontend
yarn start
```

### 3. Validation de la configuration

Depuis un terminal où les variables Emergent sont disponibles :

```bash
python scripts/check-emergent-env.py
```

Le contrôle affiche uniquement les noms de variables absentes. Il n'affiche
jamais leurs valeurs.

### 4. Domaine

Après le premier déploiement :

1. ajouter le domaine personnalisé dans Emergent ;
2. recopier dans la zone DNS du registraire les enregistrements fournis par
   Emergent ;
3. attendre la validation DNS et SSL ;
4. définir `OFFICIAL_DOMAIN`, `CORS_ORIGINS`, `CSRF_TRUSTED_ORIGINS` et
   `REACT_APP_PUBLIC_DOMAIN` avec l'URL HTTPS finale ;
5. définir `CLOUDFLARE_TURNSTILE_ALLOWED_HOSTNAMES` avec le hostname sans
   `https://`, puis l'autoriser dans Cloudflare Turnstile ;
6. reconstruire le frontend ;
7. mettre à jour chez chaque prestataire les URLs de callback/webhook vers le
   nouveau domaine.

Pour Telegram, conserver `TELEGRAM_COMMAND_POLLING_ENABLED=false` lorsqu'une
Preview et la Production peuvent tourner simultanément ou lorsque la plateforme
utilise plusieurs instances. Les alertes sortantes restent actives. Le polling
des commandes `/depot`, `/retrait` et `/echange` ne doit être activé que sur une
seule instance désignée, sinon Telegram répond avec un conflit `409`.

### 5. Migration de MongoDB

Les données Replit doivent être exportées puis importées dans la base MongoDB
Emergent avant le basculement. Conserver les identifiants des documents et les
clés `JWT_SECRET`, `SESSION_SECRET` et `SECRETS_ENCRYPTION_KEY` nécessaires à
la continuité des données chiffrées.

Avant d'ouvrir la production :

- comparer les soldes de chaque utilisateur et de chaque devise ;
- comparer les références et statuts des transactions ;
- vérifier les index uniques et TTL ;
- tester inscription, connexion, MFA, paiement, retrait et callbacks ;
- effectuer un dernier export différentiel pendant une fenêtre sans mutation ;
- basculer ensuite le DNS et les callbacks des prestataires.

## Développement sur Replit

Le workflow Replit reste disponible séparément :

```bash
bash scripts/start-replit.sh
```

Il démarre MongoDB local, FastAPI sur le port 8000 et React sur le port 5000.
Il ne doit pas être utilisé comme commande de production Emergent.