// Unwraps a supabase-js result: returns data, throws on error.
function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

module.exports = { check };
