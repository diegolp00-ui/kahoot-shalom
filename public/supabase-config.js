// Configuración de Supabase Realtime para Kahoot Shalom 2026
// Estas credenciales son PÚBLICAS (anon key y url son seguras en el frontend)
window.SHALOM_CONFIG = {
  // Configuración predeterminada o guardada en el navegador
  supabaseUrl: localStorage.getItem('shalom_sb_url') || window.__SHALOM_SB_URL || '',
  supabaseAnonKey: localStorage.getItem('shalom_sb_key') || window.__SHALOM_SB_KEY || '',
  
  // Guardar credenciales nuevas desde el panel de anfitrión
  save(url, key) {
    if (url) localStorage.setItem('shalom_sb_url', url.trim());
    if (key) localStorage.setItem('shalom_sb_key', key.trim());
    this.supabaseUrl = url ? url.trim() : this.supabaseUrl;
    this.supabaseAnonKey = key ? key.trim() : this.supabaseAnonKey;
  },

  hasSupabase() {
    return Boolean(this.supabaseUrl && this.supabaseAnonKey);
  }
};
