# Revue de sécurité Biz-transPay

**Date :** 8 octobre 2026  
**Référence :** le plan de 162 contrôles fourni dans `attached_assets/`.

## Portée et interprétation

Cette revue vérifie les protections visibles dans le code, les tests exécutés et les résultats des scanners. Elle ne certifie pas la configuration du domaine publié, des comptes Firebase/Google Cloud, des sauvegardes, ni des services opérateurs. « Implémenté » signifie qu’une protection correspondante a été repérée dans le code ; ce n’est pas une garantie d’absence de vulnérabilité. Les contrôles d’exploitation ou de déploiement qui ne peuvent pas être prouvés depuis le dépôt restent partiels ou à compléter.

Les lignes ci-dessous donnent un état pour chacun des 162 contrôles principaux du plan. Les nombreux sous-points de chaque chapitre sont résumés dans la colonne « Constat ».

| # | Contrôle | État | Constat |
|---:|---|---|---|
| 1 | Authentification et comptes | Partiel | Hachage bcrypt, limites de connexion et MFA admin existent ; la politique standard autorise encore 6 caractères et la détection de credential stuffing n’est pas démontrée. |
| 2 | Gestion des sessions | Implémenté | Sessions révocables, cookies HttpOnly/Secure/SameSite, expiration d’inactivité, rotation et déconnexion à distance sont présents. |
| 3 | Autorisation de chaque endpoint | Partiel | Contrôles de propriétaire et RBAC sont présents ; la couverture intégrale de chaque route reste à vérifier. Les routes admin non classées échouent maintenant fermées. |
| 4 | Wallet et ledger | Partiel | Les mutations de solde sont protégées et des flux atomiques existent ; un ledger append-only, indépendant et inviolable n’est pas établi par cette revue. |
| 5 | Idempotence des paiements | Partiel | L’API développeur exige une clé d’idempotence pour ses mutations ; la même garantie n’est pas prouvée pour chaque parcours interne. |
| 6 | Dépôts | Implémenté | Montants, fournisseur et état serveur sont validés ; les tests couvrent des callbacks et flux de dépôt. |
| 7 | Webhooks entrants | Partiel | Les vérifications dépendent du fournisseur ; signatures et doublons sont traités, mais timestamp/anti-rejeu uniforme sur tous les fournisseurs non démontré. |
| 8 | Retraits | Partiel | KYC, solde, validations et états fournisseur existent ; la détection d’anomalies et la couverture exhaustive de chaque route restent à établir. |
| 9 | Transferts | Partiel | Les contrôles serveur et de propriété sont présents ; limites comportementales et anti-fraude globale ne sont pas démontrées. |
| 10 | Liens de paiement | Implémenté | Les liens ont des identifiants non séquentiels et les paiements sont contrôlés côté serveur ; les mutations publiques conservent Turnstile et leurs validations. |
| 11 | API marchands/développeurs | Implémenté | Authentification par clé, portées, révocation, limites et idempotence sont présentes dans l’API versionnée. |
| 12 | Rate limiting | Partiel | Des limites globales et par API existent ; la cohérence multi-processus et la configuration de production restent à valider. |
| 13 | Anti-bot | Partiel | Turnstile protège plusieurs opérations publiques et les routes sont limitées ; une détection comportementale générale n’est pas établie. |
| 14 | Validation des données | Implémenté | Modèles serveur, bornes numériques, tailles et validations métier sont utilisés sur les opérations sensibles. |
| 15 | Injections | Implémenté | Les recherches sont structurées et les expressions utilisateur sont bornées/échappées ; le store PostgreSQL utilise son adaptateur JSONB. |
| 16 | XSS | Implémenté | Échappement React, CSP et validation des fichiers limitent l’exécution de contenu fourni par un utilisateur. |
| 17 | CSRF | Implémenté | Jeton CSRF et contrôle d’origine protègent les sessions ; les mutations de paiement public utilisent leur protection dédiée plutôt qu’un jeton de session. |
| 18 | CORS | Partiel | Les origines sont explicitement configurées, sans joker ; la liste réellement déployée n’a pas été vérifiée. |
| 19 | SSRF | Implémenté | Les webhooks marchands valident l’URL, refusent les IP non publiques, épinglent l’adresse DNS et désactivent redirections/proxy hérités. |
| 20 | Téléversements / KYC | Partiel | Des contrôles de taille/type et le traitement des images existent ; l’analyse antivirus et l’isolation de stockage de production ne sont pas vérifiées. |
| 21 | Confidentialité KYC | Implémenté | Les accès KYC sont réservés aux propriétaires et aux rôles autorisés côté serveur. |
| 22 | Chiffrement | Partiel | TLS et chiffrement applicatif de secrets existent ; le chiffrement des sauvegardes et des données au repos dépend de l’infrastructure. |
| 23 | Protection des secrets | Partiel | Les secrets serveur proviennent de variables d’environnement ; la clé Firebase signalée est une configuration client publique qui doit être restreinte dans Google Cloud. |
| 24 | Base de données | Partiel | Le code utilise un adaptateur PostgreSQL/JSONB ; rôles DB, TLS et sauvegardes ne sont pas vérifiables depuis le dépôt. |
| 25 | Redis / cache | N/A | Aucun Redis n’est utilisé par l’architecture examinée ; les limites persistantes reposent sur le store applicatif. |
| 26 | Erreurs et exceptions | Implémenté | Les erreurs externes sont assainies et les détails techniques ne sont pas destinés aux réponses client. |
| 27 | En-têtes HTTP | Partiel | CSP et en-têtes navigateur sont présents ; l’application de HSTS derrière le proxy publié doit être vérifiée en production. |
| 28 | Clickjacking | Implémenté | La politique de contenu restreint l’intégration de l’application dans des frames étrangères. |
| 29 | Endpoints inexistants / debug | Partiel | Le mode debug n’est pas activé par les changements ; l’exposition de la documentation OpenAPI en production doit être décidée et vérifiée. |
| 30 | Inventaire des API | Partiel | L’API d’intégration expose un contrat et les routes admin sont classées ; l’inventaire exhaustif de toutes les routes reste à clôturer. |
| 31 | Versionnage API | Partiel | L’API développeur est versionnée ; des routes historiques restent nécessaires à la compatibilité. |
| 32 | Administration | Implémenté | MFA, permissions RBAC et step-up protègent les actions d’administration examinées. |
| 33 | Actions admin financières | Partiel | Les changements sensibles sont soumis à permission/confirmation et journalisés ; la présence systématique du motif et des valeurs avant/après n’est pas prouvée. |
| 34 | Usurpation admin | Implémenté | MFA, sessions sécurisées, step-up et restrictions de rôle sont en place. |
| 35 | Audit log immuable | Partiel | Des événements d’audit sont enregistrés ; le stockage immuable/WORM et la résistance à l’altération ne sont pas établis. |
| 36 | Anti-fraude financière | À compléter | Aucun moteur de scoring comportemental couvrant l’ensemble des opérations n’a été établi. |
| 37 | Limites financières | Partiel | Des bornes et limites opérateur existent ; des plafonds agrégés configurables par utilisateur/jour ne sont pas démontrés partout. |
| 38 | Bénéficiaires | Partiel | Les données bénéficiaires sont validées ; délai de sécurité après modification et surveillance dédiée restent à vérifier. |
| 39 | Anti-rejeu | Partiel | Idempotence et protections de session couvrent plusieurs flux ; un nonce uniforme sur toutes les opérations sensibles n’est pas démontré. |
| 40 | Expiration des opérations | Partiel | Sessions, liens et certains paiements ont une expiration ; les délais de toutes les transactions en attente ne sont pas uniformes. |
| 41 | Réconciliation financière | Partiel | Réconciliation/callback fournisseur existe sur plusieurs flux ; une comparaison périodique exhaustive par fournisseur n’est pas démontrée. |
| 42 | « Ghost credits » | Implémenté | Les crédits reposent sur un résultat contrôlé par le backend, pas sur une valeur de succès envoyée par le navigateur. |
| 43 | Frais | Implémenté | Les frais sont recalculés côté serveur et certains montants sont figés avec la transaction. |
| 44 | Devises | Implémenté | La devise et les montants sont validés sur le serveur pour les flux examinés. |
| 45 | Taux de change | Partiel | Les taux sont obtenus/cadrés côté serveur ; l’audit complet des sources et de leur intégrité dépasse le code local vérifié. |
| 46 | Crypto | Implémenté | Les réseaux activés, actifs, adresses et paramètres crypto sont contrôlés côté serveur. |
| 47 | Clés crypto | N/A | La garde directe de clés privées n’est pas identifiée dans le flux examiné ; les opérations passent par des fournisseurs. À reclasser si Biz-transPay détient des clés. |
| 48 | Fournisseurs tiers | Partiel | Les adaptateurs sont séparés et plusieurs réponses sont validées ; la résilience et les contrats de tous les fournisseurs restent à éprouver. |
| 49 | Circuit breaker | À compléter | Aucun coupe-circuit transversal et vérifié sur les appels fournisseurs n’a été établi. |
| 50 | Timeouts | Partiel | Des appels externes définissent des timeouts ; l’exhaustivité sur tous les connecteurs n’a pas été prouvée. |
| 51 | Retries sécurisés | Partiel | Les retries de webhooks sont bornés ; l’idempotence de chaque retry financier fournisseur doit être vérifiée individuellement. |
| 52 | DDoS / DoS | Partiel | Limites applicatives et défense de la plateforme Replit complètent les protections ; le paramétrage WAF publié n’a pas été vérifié. |
| 53 | Protection des ressources | Implémenté | Une limite compte les octets réellement reçus, y compris les corps chunked sans Content-Length ; fichiers et requêtes ont aussi des bornes. |
| 54 | Pagination | Partiel | Des listes sont bornées/paginées ; l’inventaire complet des routes de lecture reste à vérifier. |
| 55 | Requêtes coûteuses | Partiel | Rate limiting et bornes de recherche existent ; les coûts DB et budgets par requête ne sont pas mesurés systématiquement. |
| 56 | Protection frontend | Implémenté | Les décisions d’autorisation et de valeur financière sont prises côté serveur. |
| 57 | Manipulation JavaScript | Implémenté | Modifier le client ne suffit pas à autoriser une mutation financière côté serveur. |
| 58 | Mass assignment | Implémenté | Les modèles et mises à jour serveur utilisent des champs explicitement acceptés. |
| 59 | Exposition de données | Partiel | Plusieurs réponses publiques sont explicitement projetées/allowlistées ; la minimisation de toutes les réponses n’a pas été auditée exhaustivement. |
| 60 | Données personnelles | Partiel | Les contrôles de propriété et d’accès existent ; masquage et rétention de chaque champ personnel restent à vérifier. |
| 61 | Notifications | Partiel | Les événements passent par des modèles et files dédiés ; le contenu de chaque canal doit être revu pour exclure toute donnée sensible. |
| 62 | Firebase / Push | Partiel | Le compte de service reste côté serveur et les tokens sont contrôlés ; la clé navigateur est publique par conception et son restriction de domaines/API reste à faire. |
| 63 | Email / SMS | Partiel | L’envoi email utilise une clé d’idempotence ; limites et anti-abus de tous les canaux ne sont pas démontrés. |
| 64 | Domaines | À valider | HTTPS, DNS et certificats du domaine publié ne peuvent pas être certifiés depuis le dépôt. |
| 65 | Configuration production | Partiel | Les scripts refusent maintenant de démarrer sans JWT_SECRET ou SESSION_SECRET ; le reste des réglages publiés demeure à vérifier. |
| 66 | Environnements | Partiel | Des paramètres distincts existent pour plusieurs fournisseurs ; l’isolation complète des données et credentials dev/test/prod n’est pas vérifiée. |
| 67 | Git / code source | Partiel | Les scanners n’ont pas trouvé de secret serveur avéré ; la clé Firebase publique déclenche SAST et l’historique Git complet n’a pas été scanné ici. |
| 68 | Dépendances | Partiel | Le garde-fou local et ses tests bloquent les motifs imbriqués dangereux ; l’audit signale encore braces 3.0.3, sans version amont corrigée disponible au contrôle. |
| 69 | CI/CD | Partiel | Des tests et scans ont été exécutés ; l’exécution obligatoire comme condition de publication n’est pas vérifiée. |
| 70 | Sauvegardes | À compléter | Chiffrement, séparation, fréquence et restauration des sauvegardes dépendent de l’exploitation et ne sont pas prouvés ici. |
| 71 | Restauration | À compléter | Aucun exercice de restauration après sinistre n’a été exécuté dans cette revue. |
| 72 | Kill switch financier | Partiel | Des désactivations ciblées existent ; un kill switch central validé pour les opérations financières n’est pas établi. |
| 73 | Maintenance sécurisée | Partiel | Les contrôles d’accès restent actifs ; un mode maintenance qui bloque proprement les mutations financières n’est pas démontré. |
| 74 | Détection d’anomalies | À compléter | Pas de surveillance comportementale exhaustive établie pour les volumes, appareils et séquences anormales. |
| 75 | Alertes admin | Partiel | Les alertes de sécurité sont asynchrones ; livraison, accusé et escalade opérationnelle ne sont pas vérifiés. |
| 76 | Surveillance des endpoints | Partiel | Les journaux existent ; tableaux de métriques, SLO et alertes sur taux d’erreur/latence ne sont pas prouvés. |
| 77 | Health check | Partiel | Le démarrage vérifie la disponibilité de l’API ; un endpoint de santé minimal et protégé, distinct du schéma OpenAPI, n’est pas établi. |
| 78 | Queues | Partiel | Certaines notifications et tâches utilisent une file ; persistance durable et reprise de toutes les files ne sont pas démontrées. |
| 79 | Transactions asynchrones | Implémenté | Les flux de paiement suivent des états serveur et conservent les résultats incertains pour réconciliation. |
| 80 | Machine d’état financière | Partiel | Les transitions critiques sont validées dans plusieurs parcours ; une machine d’état centrale couvrant tous les fournisseurs n’est pas établie. |
| 81 | Race conditions | Implémenté | Les mutations de portefeuille et les contraintes du store sont testées sous concurrence. |
| 82 | Solde temps réel | Implémenté | Le solde autoritatif est calculé/validé sur le serveur et non accepté du frontend. |
| 83 | Frais dynamiques | Partiel | Les calculs serveur existent ; le gel/versionnement de chaque règle et devis n’a pas été vérifié. |
| 84 | Historique | Implémenté | L’historique est issu de données serveur et les statuts client ne sont pas autoritatifs. |
| 85 | Références de transaction | Implémenté | Les opérations ont des identifiants/références serveur et des protections contre les doublons. |
| 86 | Modification d’historique | Partiel | Les utilisateurs ne contrôlent pas l’historique ; une piste d’audit immuable de toute correction admin reste à établir. |
| 87 | Statistiques | Implémenté | Les statistiques examinées sont calculées à partir des données serveur et protégées par des permissions. |
| 88 | Dashboard admin | Implémenté | Les routes d’administration appliquent des permissions serveur ; les routes non classées refusent désormais l’accès. |
| 89 | Séparation par pays | Partiel | Le routage et les catalogues pays sont contrôlés côté serveur ; l’isolation pays de toutes les vues admin n’a pas été vérifiée. |
| 90 | Tests de sécurité automatisés | Partiel | Tests unitaires et trois scanners ont tourné ; le parcours global reste bloqué par l’absence de REACT_APP_BACKEND_URL. |
| 91 | Non-régression financière | Partiel | Les tests ciblés dépôt, retrait, transferts, API et concurrence passent ; la suite complète de bout en bout n’a pas pu être validée. |
| 92 | Tests de concurrence | Implémenté | La suite de concurrence du store PostgreSQL et des mutations financières passe. |
| 93 | Tests IDOR | Partiel | Des tests de séparation utilisateur existent ; chaque identifiant et route publique n’a pas été couvert dans ce passage. |
| 94 | Élévation de privilèges | Implémenté | Tests RBAC/administration et le nouveau test d’échec fermé des routes non classées passent. |
| 95 | Tests de rate limit | Partiel | Des limites sont testées ; les seuils distribués et scénarios IP/compte/clé ne sont pas tous exercés. |
| 96 | Tests de webhook | Implémenté | Les tests couvrent plusieurs signatures, événements, doublons et méthodes de callback fournisseur. |
| 97 | Tests des API providers | Partiel | Plusieurs adaptateurs ont des tests unitaires/intégration simulés ; chaque fournisseur et chaque panne ne sont pas couverts. |
| 98 | Tests de récupération | Partiel | Les erreurs/retries sont testés sur certains flux ; les scénarios de restauration de données n’ont pas été exécutés. |
| 99 | Tests de pénétration | À compléter | Aucun test d’intrusion externe contrôlé n’a été exécuté dans ce travail. |
| 100 | Scanners automatiques | Partiel | Audit dépendances, SAST et HoundDog ont tourné ; DAST et analyse des routes publiées restent à faire. |
| 101 | Endpoints internes | Partiel | Des routes sensibles sont authentifiées et scopées ; l’inventaire complet des interfaces internes n’est pas établi. |
| 102 | Authentification service-à-service | N/A | L’architecture inspectée est un backend monolithique sans API inter-services identifiée. |
| 103 | Moindre privilège | Implémenté | Rôles effectifs et permissions serveur sont contrôlés séparément des composants d’interface. |
| 104 | Séparation du ledger | Partiel | Les mouvements restent dans l’architecture applicative existante ; aucun service/stockage append-only isolé n’est établi. |
| 105 | Migrations DB | Partiel | Le store est PostgreSQL/JSONB ; procédures de migration, sauvegarde préalable et rollback de production ne sont pas vérifiées. |
| 106 | Protection contre les resets | Partiel | Certaines opérations destructrices sont réservées/protégées ; les scénarios de reset global production ne sont pas testés ici. |
| 107 | Suppression de compte | Partiel | Les protections de propriété existent ; conformité de la suppression aux obligations financières et à la rétention reste à confirmer. |
| 108 | Comptes dupliqués | Partiel | Des identifiants uniques sont utilisés dans plusieurs flux ; les règles de déduplication de toutes les inscriptions ne sont pas revues. |
| 109 | Changements sensibles | Implémenté | Les actions admin critiques exigent permissions et step-up/confirmation selon leur niveau. |
| 110 | Centre de sécurité admin | À compléter | Aucun tableau de bord complet des alertes et événements d’attaque n’a été établi. |
| 111 | Journal d’audit | Partiel | Les événements importants sont journalisés ; immutabilité, conservation et consultation exhaustive restent à établir. |
| 112 | Protection des logs | Partiel | Plusieurs erreurs sont assainies et les alertes redacted ; une vérification exhaustive des champs PII/secrets n’a pas été menée. |
| 113 | Détection de fuite de secrets | Partiel | Les scans ont été exécutés ; SAST signale la clé Firebase client, et aucun scan historique Git n’a été fait. |
| 114 | Rotation des secrets | Partiel | Les secrets d’API/webhook peuvent être renouvelés ; une rotation planifiée de tous les secrets d’exploitation n’est pas démontrée. |
| 115 | Révocation rapide | Implémenté | Sessions et clés d’intégration sont révocables côté serveur. |
| 116 | Protection par fournisseur | Implémenté | Les fournisseurs ont des adaptateurs et états distincts ; leurs credentials ne sont pas remis au frontend. |
| 117 | Isolation des incidents | Partiel | Des opérations/fournisseurs peuvent être désactivés séparément ; isolation de panne complète à tester. |
| 118 | Frais provider | Implémenté | Les frais opérateur sont recalculés côté serveur et non acceptés comme vérité depuis le client. |
| 119 | Manipulation des pays | Implémenté | L’éligibilité et le routage pays sont déterminés/validés côté serveur. |
| 120 | Manipulation du prix | Implémenté | Les montants et tarifs des opérations concernées sont calculés ou vérifiés côté serveur. |
| 121 | Stocks / produits digitaux | N/A | DigiShop est seulement annoncé « Bientôt disponible » ; aucun flux de vente ou stock n’est activé. |
| 122 | Codes digitaux | N/A | La livraison de codes numériques ne s’applique pas tant que DigiShop n’est pas développé. |
| 123 | Support | Implémenté | Les rôles admin et permissions limitent les actions de support ; les données sont scoppées côté serveur. |
| 124 | Double validation | Implémenté | Les actions admin à risque utilisent step-up et confirmations explicites. |
| 125 | Séparation des responsabilités | Partiel | Les rôles sont distincts ; l’indépendance d’approbation à deux personnes pour chaque action critique n’est pas démontrée. |
| 126 | Intégrité | À compléter | Aucun contrôle périodique d’intégrité des fichiers/configurations et aucune alerte d’altération n’ont été établis. |
| 127 | Protection serveur | Partiel | Le démarrage sécurisé et les secrets d’environnement sont utilisés ; patching, durcissement système et accès opérateur dépendent de l’infrastructure. |
| 128 | Accès direct aux fichiers | Implémenté | Les fichiers de code/configuration ne sont pas exposés par le service de fichiers statiques de l’application. |
| 129 | Sauvegardes web | Partiel | Aucun accès public aux backups n’est identifié dans les routes examinées ; stockage et ACL externes restent à vérifier. |
| 130 | Variables d’environnement | Partiel | Les valeurs serveur ne sont pas exposées par les routes examinées ; la clé Firebase est un paramètre public côté navigateur. |
| 131 | Cache admin | Implémenté | Les réponses sensibles d’administration sont configurées pour éviter leur mise en cache dans le navigateur. |
| 132 | Navigateur | Partiel | CSP et protections navigateur existent ; HSTS et politiques navigateur effectives du domaine publié restent à valider. |
| 133 | Tokens | Implémenté | Les JWT ont signature/expiration, et les sessions navigateur sont révocables et HttpOnly. |
| 134 | JWT | Implémenté | La validation restreint l’algorithme configuré et vérifie signature/expiration/claims d’usage. |
| 135 | OAuth/OIDC | N/A | Aucun flux OAuth/OIDC n’est utilisé par l’authentification applicative examinée. |
| 136 | API publiques | Implémenté | Les endpoints publics gardent validation, authentification lorsque requise et projections de réponse contrôlées. |
| 137 | Recherche | Partiel | Les entrées de recherche sont bornées/échappées ; limites de charge et pagination de toutes les routes restent à vérifier. |
| 138 | Exports | Partiel | L’accès admin est contrôlé ; limites, journalisation et validation de chaque export n’ont pas été examinées intégralement. |
| 139 | CSV injection | Partiel | La couverture d’une neutralisation uniforme des cellules exportées n’est pas démontrée. |
| 140 | Statistiques financières | Implémenté | Les données statistiques sont calculées serveur et accessibles selon les permissions définies. |
| 141 | Webhooks sortants | Implémenté | Signature HMAC, secret de destination, identifiant d’événement et tentatives bornées sont présents. |
| 142 | Faux webhooks marchands | Implémenté | Le marchand reçoit une signature vérifiable et les événements sont identifiés de façon unique. |
| 143 | Retry des webhooks | Implémenté | Le nombre de tentatives est borné, les redirections sont désactivées et le résultat est persisté. |
| 144 | URLs de callback | Partiel | Les callbacks métier sont construits côté serveur ; validation du domaine officiel et en-têtes proxy de production à confirmer. |
| 145 | Redirections | Partiel | Les liens de fournisseurs exposés sont filtrés ; la validation uniforme de toutes les destinations externes reste à vérifier. |
| 146 | Phishing interne | Partiel | CSP, HTTPS et filtrage de quelques URLs protègent les flux ; détection et gouvernance des domaines nécessitent la configuration publiée. |
| 147 | Détection de compromission | À compléter | Détection générale d’un compte compromis, appareil inconnu et séquences anormales non établie. |
| 148 | Notifications de sécurité | Partiel | Des alertes asynchrones existent ; leur réception par les administrateurs n’a pas été confirmée de bout en bout. |
| 149 | Confidentialité | Partiel | Les accès et réponses publiques sont limités ; cartographie complète des données et minimisation de tous les champs à terminer. |
| 150 | Rétention | À compléter | Une politique exhaustive de conservation/suppression des données personnelles et journaux n’est pas établie. |
| 151 | Réponse aux incidents | À compléter | Aucun playbook d’incident, responsabilités et procédure d’escalade n’a été validé dans ce travail. |
| 152 | Incident financier | À compléter | Procédure de gel ciblé, rapprochement et décision humaine lors d’un incident financier à formaliser/tester. |
| 153 | Réconciliation après incident | Partiel | Les mécanismes de réconciliation fournisseur existent sur certains flux ; le processus post-incident n’a pas été exercé. |
| 154 | Tests de charge | À compléter | Aucun test de charge n’a été exécuté. |
| 155 | Tests de chaos/panne | À compléter | Aucun test de panne contrôlée sur les fournisseurs ou la base n’a été exécuté. |
| 156 | Tests avant production | Partiel | Tests et scans ciblés passent ; la suite e2e, la configuration publiée et une validation préproduction complète restent nécessaires. |
| 157 | Règle pour opérations financières | Partiel | Le backend et les états fournisseur font autorité ; la preuve de paiement s’applique, mais l’exhaustivité du ledger reste partielle. |
| 158 | Règle pour les soldes | Implémenté | Le serveur/store est la source autoritative des soldes. |
| 159 | Règle pour les webhooks | Partiel | Les callbacks vérifient la provenance et l’idempotence selon le fournisseur ; une règle unique de timestamp ne s’applique pas partout. |
| 160 | Règle pour les endpoints | Partiel | Les routes sensibles ont accès, validation et limites ; l’inventaire complet endpoint par endpoint reste à achever. |
| 161 | Non-régression Biz-transPay | Implémenté | Aucun flux métier n’a été remplacé ; les suites ciblées de retraits, dépôts, API, CSRF et concurrence passent. |
| 162 | Déploiement progressif | Partiel | Les changements sont testés localement ; aucun déploiement progressif, exercice de surveillance ni test de production n’a été effectué. |

## Corrections appliquées pendant cette revue

1. **Autorisation admin en échec fermé :** une route d’administration non classée ne reçoit plus par défaut la permission de lecture des paramètres ; elle doit être explicitement autorisée.
2. **Limite de taille réelle du corps HTTP :** les corps API sont comptés pendant leur réception. Un corps chunked trop volumineux reçoit `413`, même sans en-tête `Content-Length`; les requêtes valides sont conservées.
3. **Secret de session obligatoire au démarrage :** les lanceurs de développement et de production refusent désormais de démarrer si `JWT_SECRET` et `SESSION_SECRET` sont absents, au lieu d’utiliser `dev-secret`.
4. **Modèle de menace :** description de la persistance PostgreSQL/JSONB et des protections de corps HTTP, permissions admin et SSRF mise à jour dans `threat_model.md`.

## Vérifications exécutées

- Tests ciblés sécurité/admin/notifications : **57 réussis**.
- Tests API, paiements, retrait, CSRF, concurrence et KYC : **90 réussis, 1 ignoré**.
- Tests du garde-fou local `braces` : **4 réussis**.
- Suite backend complète tentée : **426 réussis, 29 échecs, 68 erreurs, 13 ignorés**. Ce résultat n’est pas un feu vert global : `REACT_APP_BACKEND_URL` n’était pas configuré, plusieurs tests e2e n’ont pas pu collecter ou ont reçu une réponse 404. Une suite complète exige un backend de test isolé ; elle ne doit pas être dirigée vers des données financières de production.
- Scanners : dépendances **2 alertes HIGH** ; SAST **1 alerte MEDIUM** ; HoundDog **0 finding**.

## Points prioritaires qui restent ouverts

- **Dépendance `braces@3.0.3` :** deux occurrences du même avis `GHSA-vfj7-8cjw-p6xm` restent signalées par l’audit. Le paquet ne publie pas encore de version corrigée ; le correctif local vérifié limite la profondeur d’analyse à 64 et préserve les motifs normaux, mais le résultat ne doit pas être présenté comme une mise à niveau amont.
- **Clé web Firebase :** SAST la signale dans `.replit`. Elle est distribuée au navigateur comme configuration Firebase publique, donc elle ne peut pas être traitée comme un secret serveur. Restreindre dans Google Cloud les API permises et les domaines/référents autorisés ; cette configuration externe n’a pas été vérifiée.
- **Essais de bout en bout :** configurer un environnement backend de test et relancer les parcours sans données de production.
- **Exploitation :** vérifier les sauvegardes/restaurations, les règles CORS/HSTS/WAF du domaine publié, la rotation des secrets, les alertes, le kill switch, la surveillance et la procédure de réponse aux incidents.
- **Travaux étendus :** valider l’existence d’un ledger append-only, compléter la détection antifraude, décider du circuit breaker des fournisseurs, puis réaliser des tests de charge, de panne et de pénétration contrôlés.

