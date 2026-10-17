/**
 * assets/js/products.js
 * Quản lý Data Fetching sản phẩm từ Supabase BaaS
 * Tách biệt hoàn toàn với logic Render DOM
 */

import { supabase } from './supabaseClient.js';

/**
 * Lấy danh sách sản phẩm đang kinh doanh (is_active = true)
 * @param {Object} options - Tùy chọn lọc
 * @param {string} options.category - Danh mục cần lọc ('all', 'table', 'chair', 'cabinet', ...)
 * @returns {Promise<{success: boolean, data: Array, error?: string}>}
 */
export async function fetchProducts({ category = 'all' } = {}) {
  try {
    let query = supabase
      .from('products')
      .select('id, name, slug, category, material, dimensions, price, stock, image_url, description, is_active')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[mộcnhà. Products] Lỗi truy vấn bảng products:', error.message);
      return { success: false, data: [], error: error.message };
    }

    return {
      success: true,
      data: Array.isArray(data) ? data : []
    };
  } catch (err) {
    console.error('[mộcnhà. Products] Ngoại lệ khi fetch products:', err.message);
    return {
      success: false,
      data: [],
      error: err.message || 'Lỗi không xác định khi kết nối cơ sở dữ liệu.'
    };
  }
}

/**
 * Lấy chi tiết một sản phẩm theo ID
 * @param {string} productId - UUID của sản phẩm
 * @returns {Promise<{success: boolean, data: Object|null, error?: string}>}
 */
export async function fetchProductById(productId) {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, slug, category, material, dimensions, price, stock, image_url, description')
      .eq('id', productId)
      .eq('is_active', true)
      .single();

    if (error) {
      return { success: false, data: null, error: error.message };
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, data: null, error: err.message };
  }
}
