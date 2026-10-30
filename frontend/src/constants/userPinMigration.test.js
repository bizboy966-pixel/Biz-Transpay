import {
  isUserPinSetupRequired,
  USER_PIN_MIGRATION_SETUP_PATH,
  USER_PIN_SETUP_REQUIRED_CODE,
} from './userPinMigration';

describe('user PIN migration recovery', () => {
  it('recognizes the server response for a PIN that is not present after migration', () => {
    expect(isUserPinSetupRequired({
      response: { data: { detail: { code: USER_PIN_SETUP_REQUIRED_CODE } } },
    })).toBe(true);
    expect(isUserPinSetupRequired({ response: { data: { detail: { code: 'USER_PIN_INVALID' } } } }))
      .toBe(false);
    expect(isUserPinSetupRequired(null)).toBe(false);
  });

  it('redirects the user to a login that explains PIN re-enrollment', () => {
    expect(USER_PIN_MIGRATION_SETUP_PATH).toBe('/login?pin_setup_required=1');
  });
});
