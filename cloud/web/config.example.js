// Copy to config.js and fill in from Supabase -> Project Settings -> API.
// The ANON key is safe in the browser: RLS lets it read public tables and
// insert a registration, nothing else. NEVER put the service_role key here.
const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY"
};
