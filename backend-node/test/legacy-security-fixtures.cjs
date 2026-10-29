'use strict';

// Fixed synthetic compatibility vectors captured before the legacy runtime was removed.
module.exports = {
  password_hash: '$2b$12$wRWWtVoFHFQP4nXW/0sf5eiUfRLBoPENjLCGgphE5cJm5iMNvTPKe',
  user_pin_hash: '$2b$12$f5TcmVjIbzYuQF5btp1qo.QfyqSysa0Ate3gqsicklS1XyDuYB9qK',
  admin_pin_hash: '$2b$12$VfYwzaHagWjyF6jSecv1r..gj2CUL8tIRO185qY8TnOd5iB1ErRpy',
  user_pin_material: 'bc8913e35045772de36a4aba2c90a368956f2753fdca6617384fee2ace6da78a',
  encrypted_mfa: 'gAAAAABq4uv9s0PWERDecDJB21anOR_mUHD0K6MKtdjJpj_eHiVzQU-UvaA3qiqGzPv94vvlMMsnhRdq-AfbQfmmMCU0cH6qDW3CR7PU_L8yZKf5yifXRDQ=',
  encrypted_integration: 'gAAAAABq4uv-5zhoCLfOOAnTzOEQIQUVuRtJ1ZBLBVmLZVQhj1EpFBCDpeAa1wEWsyptxQcmpueJZp8lIjZwZ_HMy3W6NkgYJut5pb_uu9gbYNaspveg__E=',
  explicit_integration_key: 'IJnIyB4_VagZMj1CQLbok4z9_K7vRL8mqzr4JCK8l18=',
  encrypted_explicit_integration: 'gAAAAABq4uv-Ys4PXRAGAW0z16QAebGIrOB2tA1IcQFuMlk7uSVxAC0aIBau-EZb2_u-NVResLaqaE_qNio5A8D2HE7OLg2-onOGQPL7Z8XUBEQSlePuaMk=',
  password_policy: [
    {
      user: ['au moins 6 caractères', 'une lettre minuscule', 'une lettre majuscule', 'un chiffre', 'un caractère spécial'],
      admin: ['au moins 6 caractères', 'une lettre minuscule', 'une lettre majuscule', 'un chiffre', 'un caractère spécial', 'un mot de passe administrateur d\'au moins 14 caractères'],
    },
    {
      user: ['au moins 6 caractères', 'une lettre majuscule', 'un chiffre', 'un caractère spécial'],
      admin: ['au moins 6 caractères', 'une lettre majuscule', 'un chiffre', 'un caractère spécial', 'un mot de passe administrateur d\'au moins 14 caractères'],
    },
    { user: [], admin: [] },
    {
      user: ['un chiffre'],
      admin: ['un chiffre', 'un mot de passe administrateur d\'au moins 14 caractères'],
    },
    { user: [], admin: ['un mot de passe administrateur d\'au moins 14 caractères'] },
    { user: [], admin: [] },
    { user: ['au maximum 72 caractères'], admin: ['au maximum 72 caractères'] },
  ],
  totp: '324550',
  token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlciIsInNpZCI6InN5bnRoZXRpYy1zZXNzaW9uIiwidHlwIjoic2Vzc2lvbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMzAwfQ.EfN_CwRltkp99fweEV5aqHInUyhIfKY9t6oWBP-t-WQ',
  signature_vectors: [
    { value: 500, signature: '9745656d0dacabeb3b875e0c3cba97aaa04ce42f9ea946b559bded475bd0e14a' },
    { value: 0.025, signature: 'fb4877c39de810d57f881231055a8a400bb61d69f7ab78a91dd752ba3d89ad54' },
    { value: 1e-5, signature: '64641361ba8c4f90fbbe25a8ab5aadae2abde9e5560e942a23fbbdb577aaa332' },
    { value: 0.0001, signature: '59066e535de53afea8c37bdbe0819d7be2dacc7064119911b8c3ef361254b277' },
    { value: 1e16, signature: 'dabdc15bb42b6c944269e55883d151831e7b32b7de4349aa8d88ef4b3bbac159' },
    { value: -20, signature: 'aee7ccbfbaf0ec2c445c75e9a5c7f1639fa1ae8ec3ebbc783a36ccb60d95c6de' },
    { value: 0.30000000000000004, signature: '10f2922707e9039a3a2024307aa18470c9b0d179f76ed6f07909e2c1c9ac0fa2' },
  ],
};
