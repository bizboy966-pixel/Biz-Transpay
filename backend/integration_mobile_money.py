"""Provider-neutral Mobile Money discovery and integration guides.

Provider contracts checked against PayDunya's official documentation:
https://developers.paydunya.com/doc/EN/softpay#section-9
https://developers.paydunya.com/doc/EN/softpay#section-10
https://developers.paydunya.com/doc/EN/api_deboursement
https://www.orange.bf/fr/assistance/assistance-paiement-boutique-en-ligne.html
Never send provider credentials or internal routing in the merchant catalogue.
"""
import json


async def operator_catalog(ctx, direction, user_id):
    if direction == "deposit":
        config = await ctx["deposits_config_public"](surface="dashboard")
        enabled = bool(config.get("mobile_money_enabled"))
        rows = [
            {**operator, "country": country["country"],
             "country_label": country.get("country_label")}
            for country in config.get("catalog", [])
            for operator in country.get("operators", [])
        ]
    else:
        config = await ctx["transfer_config"](user_id)
        section = config.get("mobile_money") or {}
        enabled = bool(section.get("enabled"))
        rows = section.get("operators") or []
    result = []
    for row in rows if enabled else []:
        public = {key: row.get(key) for key in (
            "country", "country_label", "code", "name", "currency", "min", "max")}
        if direction == "deposit":
            flow = row.get("payment_flow") or {}
            public["payment_flow"] = {key: flow[key] for key in (
                "kind", "before_submit", "otp_required", "otp_label",
                "ussd_code", "ussd_template", "steps", "instructions", "action_label",
            ) if key in flow}
        result.append(public)
    return {
        "direction": direction, "enabled": enabled, "operators": result,
        "availability_source": "serving_environment_configuration",
    }


def _curl(path, payload, key):
    return (
        f'curl -X POST "$BIZ_BASE_URL/api/integration/v1/{path}" \\\n'
        '  -H "Authorization: Bearer $BIZ_SECRET_KEY" \\\n'
        '  -H "X-Public-Key: $BIZ_PUBLIC_KEY" \\\n'
        f'  -H "Idempotency-Key: {key}" \\\n'
        '  -H "Content-Type: application/json" \\\n'
        f"  -d '{json.dumps(payload, ensure_ascii=False)}'"
    )


def burkina_guides():
    buyer = {
        "amount": 500, "currency": "XOF", "country": "BF",
        "phone_number": "70000000", "email": "buyer@example.com",
        "full_name": "Client exemple",
    }
    return [
        {
            "id": "mobile-money-discovery", "title": "Opérateurs Mobile Money activés",
            "description": (
                "Avant de proposer un opérateur, consultez GET /api/integration/v1/mobile-money/operators"
                "?direction=deposit ou ?direction=payout avec les deux clés API. Utilisez le code renvoyé "
                "pour cette direction, le pays, la devise et les limites min/max. Les codes de dépôt et "
                "de retrait peuvent différer. Le catalogue décrit les routes activées dans l’environnement "
                "qui sert la requête, pas une garantie de disponibilité du réseau ni du solde du prestataire. "
                "Les clés test peuvent lire le catalogue mais les écritures financières test restent "
                "bloquées tant qu’un environnement officiel isolé n’est pas configuré. Pour les dépôts, "
                "payment_flow indique l’action à présenter au client ; remplacez {amount} dans "
                "ussd_template par le montant total envoyé à l’API."
            ),
        },
        {
            "id": "burkina-moov-deposits", "title": "Moov Money Burkina — dépôt automatique",
            "description": (
                "Pays BF, devise XOF, code de dépôt habituel moov_bf : vérifiez sa présence dans le "
                "catalogue deposit. Envoyez POST /api/integration/v1/deposits avec le numéro du client, "
                "son nom, son e-mail, le montant et une Idempotency-Key. Aucun OTP n’est demandé avant "
                "l’envoi pour le parcours USSD. La réponse {id,status,deposit} fournit "
                "deposit.payment_flow. Après l’initiation, demandez au client de composer *555*6# "
                "depuis le même numéro Moov Money et de confirmer dans le menu. N’annoncez pas une "
                "notification automatique. L’initiation pending n’est pas une réussite : consultez "
                "GET /api/integration/v1/deposits/{id} jusqu’à approved ou un état d’échec, ou traitez "
                "le webhook payment.success/payment.failed signé puis consultez GET. "
                "La vérification continue côté serveur même si le client ferme la page. "
                "Ne créez pas un second dépôt lors d’un timeout ; rejouez seulement la requête identique "
                "avec la même clé. Le numéro et le code OTP des exemples sont fictifs."
            ),
            "examples": {"curl": _curl(
                "deposits", {**buyer, "operator": "moov_bf", "reference": "bf-moov-order"},
                "bf-moov-order")},
        },
        {
            "id": "burkina-orange-deposits", "title": "Orange Money Burkina — dépôt avec OTP",
            "description": (
                "Pays BF, devise XOF, code de dépôt habituel orange_bf : vérifiez le catalogue deposit. "
                "Renseignez d’abord le numéro et le montant. Pour le parcours OTP, le client compose "
                "*144*4*6*MONTANT# sur le téléphone associé à son numéro, suit le menu et génère le code "
                "de paiement. Pour amount=500, le code est *144*4*6*500#. Envoyez ensuite "
                "POST /api/integration/v1/deposits avec otp contenant le véritable code généré ; "
                "12345 est seulement une valeur illustrative à remplacer, jamais un code de test. "
                "Dans l’API, amount est déjà le total payé, frais inclus : le marchand reçoit ce total "
                "moins les frais. Si vous voulez un total de 520, envoyez amount=520 et générez le code "
                "pour 520. Ne rajoutez pas une seconde fois les frais ; fee_bearer historique est ignoré. "
                "L’absence d’OTP renvoie HTTP 400 avec detail.code=OTP_REQUIRED et detail.payment_flow "
                "avant toute soumission ; dans ce seul cas, complétez otp et réutilisez la même "
                "Idempotency-Key (aucune opération n’a été envoyée). Après acceptation, affichez "
                "deposit.payment_flow et suivez GET /api/integration/v1/deposits/{id} ou les webhooks "
                "payment.success/payment.failed signés. Seul approved autorise à finaliser la commande, "
                "pas HTTP 200 ni pending. Une issue incertaine conserve sa clé d’idempotence."
            ),
            "examples": {"curl": _curl(
                "deposits", {**buyer, "operator": "orange_bf", "otp": "12345",
                             "reference": "bf-orange-order"},
                "bf-orange-order")},
        },
        {
            "id": "burkina-payouts", "title": "Moov et Orange Burkina — retrait automatique",
            "description": (
                "Consultez le catalogue payout, distinct du catalogue deposit. Les codes de retrait "
                "usuels sont moov-burkina-faso et orange-money-burkina ; utilisez toujours le code "
                "effectivement renvoyé par le catalogue de votre environnement. Envoyez "
                "POST /api/integration/v1/payouts avec country=BF, currency=XOF, recipient (numéro "
                "du bénéficiaire), amount et une Idempotency-Key unique. Aucun OTP de dépôt ni "
                "confirmation *555*6# n’est demandé par cet endpoint de retrait. La clé live doit "
                "avoir payouts:write, l’autorisation explicite de retrait et un compte KYC approuvé. "
                "Le marchand doit disposer du montant et des frais ; le bénéficiaire reçoit amount "
                "intact, les frais sont ajoutés au débit marchand. HTTP 200/pending signifie seulement "
                "que la demande est prise en charge. Suivez GET /api/integration/v1/payouts/{id} ou "
                "les webhooks payout.success/payout.failed signés et confirmez l’état par GET. "
                "completed indique une réussite. Un résultat incertain ou une revue manuelle ne doit "
                "jamais déclencher un second retrait ; réutilisez uniquement la même clé pour la "
                "requête identique. Un opérateur absent du catalogue ne doit pas être proposé."
            ),
            "examples": {"curl": "\n\n".join(
                _curl("payouts", {
                    "amount": 500, "currency": "XOF", "country": "BF",
                    "recipient": "70000000", "operator": operator,
                    "reference": f"bf-{name}-payout",
                }, f"bf-{name}-payout")
                for operator, name in (
                    ("moov-burkina-faso", "moov"), ("orange-money-burkina", "orange"))
            )},
        },
    ]
