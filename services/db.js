// Unwraps a supabase-js result: returns data, throws on error (keeping the
// Postgres / PostgREST error code so callers can tell "not set up" apart).
function check({ data, error }) {
  if (error) {
    const err = new Error(error.message || String(error));
    err.code = error.code;
    throw err;
  }
  return data;
}

// Missing table / function: schema.sql has not been run on this database.
const NOT_SET_UP_CODES = new Set(['42P01', 'PGRST205', 'PGRST202', '42883']);
const isNotSetUp = (err) => NOT_SET_UP_CODES.has(err?.code);

module.exports = { check, isNotSetUp };
