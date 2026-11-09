// Stand-in for firebase-admin: a token "token-for:<email>" is valid for that email.
module.exports = {
  auth: () => ({
    verifyIdToken: async (token) => {
      if (!String(token).startsWith('token-for:')) throw new Error('invalid token');
      return { email: token.slice('token-for:'.length) };
    },
  }),
};
