export const USER_PIN_SETUP_REQUIRED_CODE = 'USER_PIN_SETUP_REQUIRED';
export const USER_PIN_MIGRATION_SETUP_PATH = '/login?pin_setup_required=1';
export const USER_PIN_MIGRATION_NOTICE = 'Votre ancien code PIN n’a pas été repris par le nouveau serveur. Connectez-vous, puis activez un PIN pour cette version. Vous pouvez choisir le même code.';

export function isUserPinSetupRequired(error) {
  return error?.response?.data?.detail?.code === USER_PIN_SETUP_REQUIRED_CODE;
}
