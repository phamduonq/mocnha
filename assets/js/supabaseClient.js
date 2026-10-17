/**
 * assets/js/supabaseClient.js
 * Quản lý khởi tạo Supabase Client duy nhất (Singleton Pattern)
 * Import trực tiếp từ ESM để tránh Race Condition với thẻ script CDN
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Supabase Credentials
const SUPABASE_URL = 'https://asrchqwhigudyawfhuuk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_deSvzLnkwiQk_OtzkasaOA_DohlscES';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: window.localStorage
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

/**
 * Helper kiểm tra trạng thái kết nối tới Supabase BaaS
 */
export async function testSupabaseConnection() {
  try {
    const { data, error } = await supabase.from('products').select('id').limit(1);
    if (error) throw error;
    console.log('[mộcnhà. Supabase] Kết nối BaaS thành công. Dữ liệu thử nghiệm:', data);
    return { connected: true, data };
  } catch (err) {
    console.error('[mộcnhà. Supabase] Lỗi kết nối BaaS:', err.message);
    return { connected: false, error: err.message };
  }
}
