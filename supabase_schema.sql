-- ==============================================================================
-- MỘCNHÀ. — SUPABASE DATABASE SCHEMA & RBAC ARCHITECTURE (HOTFIX V2)
-- Hệ thống Phân quyền theo vai trò (Admin / Customer / Guest) & Row Level Security (RLS)
-- ==============================================================================

-- 1. BẬT TIỆN ÍCH EXTENSION (UUID GENERATOR)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==============================================================================
-- 2. BẢNG PUBLIC.PROFILES (LIÊN KẾT 1-1 VỚI AUTH.USERS)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Tối ưu hóa truy vấn tìm kiếm vai trò
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);

COMMENT ON TABLE public.profiles IS 'Bảng hồ sơ người dùng lưu trữ RBAC role (admin/customer), liên kết 1-1 với auth.users.';
COMMENT ON COLUMN public.profiles.role IS 'Vai trò RBAC: Chỉ chấp nhận admin hoặc customer. Mặc định luôn là customer.';

-- ==============================================================================
-- 3. HÀM KIỂM TRA QUYỀN PUBLIC.IS_ADMIN() TỐI ƯU HIỆU NĂNG
-- ==============================================================================
-- Sử dụng STABLE, SECURITY DEFINER và subquery (SELECT auth.uid()) để PostgreSQL query planner
-- cache kết quả kiểm tra UID (InitPlan) trong suốt execution plan, giảm tải tối đa cho DB.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.profiles 
    WHERE id = (SELECT auth.uid()) 
      AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ==============================================================================
-- 4. BẢO VỆ CỘT NHẠY CẢM TRÊN PUBLIC.PROFILES BẰNG TRIGGER FUNCTION
-- ==============================================================================
-- Chặn người dùng thường (authenticated, không phải admin) sửa đổi id, email, role, created_at.
-- Chỉ Admin mới có quyền thay đổi role hoặc chỉnh sửa thông tin hệ thống của tài khoản.
CREATE OR REPLACE FUNCTION public.protect_profile_immutable_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    -- Chặn tuyệt đối mọi cố gắng thay đổi id, email hoặc thăng cấp role từ phía client thông thường
    NEW.id := OLD.id;
    NEW.email := OLD.email;
    NEW.role := OLD.role;
    NEW.created_at := OLD.created_at;
  END IF;

  -- Luôn tự động cập nhật thời điểm sửa đổi
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_immutable_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_immutable_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_immutable_columns();

-- ==============================================================================
-- 5. DATABASE TRIGGER TỰ ĐỘNG KHỞI TẠO PROFILE (CHỐNG PRIVILEGE ESCALATION)
-- ==============================================================================
-- Gán cứng role = 'customer' ngay tại Trigger, ngăn chặn hoàn toàn việc người dùng
-- tự gửi { role: 'admin' } trong options.data từ trình duyệt khi đăng ký.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    phone,
    role,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'phone', ''),
    'customer', -- CỐ ĐỊNH: Bất kể metadata từ client gửi lên là gì, luôn là customer
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = CASE 
      WHEN public.profiles.full_name IS NULL OR public.profiles.full_name = '' 
      THEN EXCLUDED.full_name 
      ELSE public.profiles.full_name 
    END,
    phone = CASE 
      WHEN public.profiles.phone IS NULL OR public.profiles.phone = '' 
      THEN EXCLUDED.phone 
      ELSE public.profiles.phone 
    END,
    updated_at = timezone('utc'::text, now());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ==============================================================================
-- 6. BẢNG SẢN PHẨM (PUBLIC.PRODUCTS)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  category TEXT NOT NULL,
  material TEXT,
  dimensions TEXT,
  price NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_url TEXT,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_products_category ON public.products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON public.products(is_active);

-- Tự động cập nhật updated_at cho products
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_products_updated_at ON public.products;
CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

-- ==============================================================================
-- 7. BẢNG ĐƠN HÀNG (PUBLIC.ORDERS) & CHI TIẾT ĐƠN HÀNG (PUBLIC.ORDER_ITEMS)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- NULL nếu là Guest order
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  shipping_address TEXT NOT NULL,
  note TEXT,
  total_amount NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'shipping', 'completed', 'cancelled')),
  payment_method TEXT NOT NULL DEFAULT 'vietqr_mock',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);

DROP TRIGGER IF EXISTS set_orders_updated_at ON public.orders;
CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  subtotal NUMERIC(12, 0) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items(order_id);

-- ==============================================================================
-- 8. THIẾT LẬP ROW LEVEL SECURITY (RLS) POLICIES
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- A. BẢNG PUBLIC.PROFILES
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own_or_admin" ON public.profiles;
CREATE POLICY "profiles_select_own_or_admin"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) = id 
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK (
    (SELECT auth.uid()) = id
    AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "profiles_admin_manage_all" ON public.profiles;
CREATE POLICY "profiles_admin_manage_all"
  ON public.profiles
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ------------------------------------------------------------------------------
-- B. BẢNG PUBLIC.PRODUCTS
-- ------------------------------------------------------------------------------
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_read_active_or_admin" ON public.products;
CREATE POLICY "products_read_active_or_admin"
  ON public.products
  FOR SELECT
  TO anon, authenticated
  USING (
    is_active = true 
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "products_admin_all" ON public.products;
CREATE POLICY "products_admin_all"
  ON public.products
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ------------------------------------------------------------------------------
-- C. BẢNG PUBLIC.ORDERS & PUBLIC.ORDER_ITEMS
-- ------------------------------------------------------------------------------
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_admin_all" ON public.orders;
CREATE POLICY "orders_admin_all"
  ON public.orders
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "orders_customer_select_own" ON public.orders;
CREATE POLICY "orders_customer_select_own"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "orders_customer_insert_own" ON public.orders;
CREATE POLICY "orders_customer_insert_own"
  ON public.orders
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "order_items_admin_all" ON public.order_items;
CREATE POLICY "order_items_admin_all"
  ON public.order_items
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "order_items_customer_select_own" ON public.order_items;
CREATE POLICY "order_items_customer_select_own"
  ON public.order_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders 
      WHERE orders.id = order_items.order_id 
        AND orders.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "order_items_customer_insert_own" ON public.order_items;
CREATE POLICY "order_items_customer_insert_own"
  ON public.order_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.orders 
      WHERE orders.id = order_items.order_id 
        AND orders.user_id = (SELECT auth.uid())
    )
  );

-- ==============================================================================
-- 9. POSTGRES RPC FUNCTION: PROCESS_CHECKOUT (HOTFIXED)
-- ==============================================================================
-- Các cải tiến tối ưu & bảo mật:
-- 1. Validate số điện thoại chuẩn Regex Việt Nam: ^(0|\+84)[3|5|7|8|9][0-9]{8}$
-- 2. Giới hạn số lượng mặt hàng tối đa 20 items/đơn để chống Inventory DoS.
-- 3. Gom nhóm (GROUP BY product_id, SUM(quantity)) xử lý trường hợp mảng JSON trùng ID.
-- 4. Sắp xếp (ORDER BY product_id ASC) triệt tiêu hoàn toàn Database Deadlock.
-- 5. Trạng thái khởi tạo đơn hàng là 'pending' (thay vì 'paid').
-- 6. Tối ưu: Insert order_items ngay trong luồng duy nhất khi đang giữ lock dòng.
-- 7. Khối EXCEPTION bảo mật: Chỉ hiển thị chi tiết khi SQLSTATE = 'P0001', che giấu lỗi SQL nội bộ.
CREATE OR REPLACE FUNCTION public.process_checkout(
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_shipping_address TEXT,
  p_note TEXT DEFAULT '',
  p_items JSONB DEFAULT '[]'::jsonb,
  p_customer_email TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_order_id UUID;
  v_item RECORD;
  v_prod RECORD;
  v_subtotal NUMERIC(12, 0);
  v_total_amount NUMERIC(12, 0) := 0;
  v_trimmed_phone TEXT;
BEGIN
  -- 1. KIỂM TRA ĐẦU VÀO NGHIÊM NGẶT (INPUT VALIDATION)
  IF TRIM(COALESCE(p_customer_name, '')) = '' THEN
    RAISE EXCEPTION 'Họ và tên người nhận hàng không được để trống.' USING ERRCODE = 'P0001';
  END IF;

  v_trimmed_phone := REGEXP_REPLACE(TRIM(COALESCE(p_customer_phone, '')), '\s+', '', 'g');
  IF v_trimmed_phone !~ '^(0|\+84)[3|5|7|8|9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Số điện thoại không đúng định dạng di động Việt Nam (Ví dụ: 0901234567 hoặc +84901234567).' USING ERRCODE = 'P0001';
  END IF;

  IF TRIM(COALESCE(p_shipping_address, '')) = '' THEN
    RAISE EXCEPTION 'Địa chỉ giao hàng không được để trống.' USING ERRCODE = 'P0001';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Giỏ hàng đang trống. Vui lòng chọn ít nhất một tác phẩm.' USING ERRCODE = 'P0001';
  END IF;

  -- Chống Inventory DoS: Giới hạn tối đa 20 mặt hàng khác nhau trong 1 đơn
  IF jsonb_array_length(p_items) > 20 THEN
    RAISE EXCEPTION 'Mỗi đơn hàng chỉ được chứa tối đa 20 mặt hàng khác nhau để đảm bảo xử lý.' USING ERRCODE = 'P0001';
  END IF;

  -- 2. XÁC ĐỊNH USER ID
  -- Authenticated = UUID người dùng; Anon (Guest) = NULL
  v_user_id := auth.uid();

  -- 3. TẠO BẢN GHI ĐƠN HÀNG VỚI TRẠNG THÁI 'pending' (CHƯA THANH TOÁN)
  INSERT INTO public.orders (
    user_id,
    customer_name,
    customer_phone,
    customer_email,
    shipping_address,
    note,
    total_amount,
    status,
    payment_method,
    created_at,
    updated_at
  )
  VALUES (
    v_user_id,
    TRIM(p_customer_name),
    v_trimmed_phone,
    TRIM(p_customer_email),
    TRIM(p_shipping_address),
    TRIM(p_note),
    0, -- Khởi tạo tạm thời = 0, cập nhật sau khi tính tiền chính xác
    'pending', -- BẮT BUỘC: Đơn hàng ở trạng thái 'pending' chờ xác nhận thanh toán
    'vietqr_mock',
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  )
  RETURNING id INTO v_order_id;

  -- 4. GOM NHÓM & SẮP XẾP CHỐNG DEADLOCK, KHÓA DÒNG VÀ TẠO ORDER_ITEMS TRONG CÙNG MỘT LUỒNG
  FOR v_item IN 
    SELECT 
      product_id, 
      SUM(quantity)::INTEGER AS quantity
    FROM jsonb_to_recordset(p_items) AS x(product_id UUID, quantity INTEGER)
    WHERE product_id IS NOT NULL
    GROUP BY product_id
    ORDER BY product_id ASC -- BẮT BUỘC SẮP XẾP ĐỂ TRIỆT TIÊU DATABASE DEADLOCK
  LOOP
    IF v_item.quantity <= 0 THEN
      RAISE EXCEPTION 'Số lượng đặt mua cho mỗi tác phẩm phải lớn hơn 0.' USING ERRCODE = 'P0001';
    END IF;

    -- Khóa dòng sản phẩm theo thứ tự tăng dần đã sắp xếp
    SELECT id, name, price, stock, is_active 
    INTO v_prod
    FROM public.products
    WHERE id = v_item.product_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tác phẩm với ID % không tồn tại trong hệ thống.', v_item.product_id USING ERRCODE = 'P0001';
    END IF;

    IF v_prod.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Tác phẩm "%" hiện đã tạm ngưng kinh doanh.', v_prod.name USING ERRCODE = 'P0001';
    END IF;

    IF v_prod.stock < v_item.quantity THEN
      RAISE EXCEPTION 'Tác phẩm "%" không đủ tồn kho (chỉ còn % chiếc trong kho).', v_prod.name, v_prod.stock USING ERRCODE = 'P0001';
    END IF;

    -- Trừ tồn kho sản phẩm
    UPDATE public.products
    SET stock = stock - v_item.quantity,
        updated_at = timezone('utc'::text, now())
    WHERE id = v_prod.id;

    -- Tính tiền dòng và cộng dồn
    v_subtotal := v_prod.price * v_item.quantity;
    v_total_amount := v_total_amount + v_subtotal;

    -- INSERT ngay vào public.order_items trong cùng luồng khóa dòng, không cần vòng lặp SELECT thứ 2
    INSERT INTO public.order_items (
      order_id,
      product_id,
      product_name,
      quantity,
      unit_price,
      subtotal,
      created_at
    )
    VALUES (
      v_order_id,
      v_prod.id,
      v_prod.name,
      v_item.quantity,
      v_prod.price,
      v_subtotal,
      timezone('utc'::text, now())
    );
  END LOOP;

  -- 5. CẬP NHẬT TỔNG TIỀN CUỐI CÙNG VÀO ĐƠN HÀNG
  UPDATE public.orders
  SET total_amount = v_total_amount,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_order_id;

  -- 6. PHẢN HỒI KẾT QUẢ THÀNH CÔNG CHO CLIENT
  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'total_amount', v_total_amount,
    'status', 'pending',
    'is_guest', (v_user_id IS NULL),
    'message', 'Đơn hàng đã được khởi tạo thành công ở trạng thái chờ thanh toán.'
  );

EXCEPTION
  WHEN OTHERS THEN
    -- BẢO VỆ CẤU TRÚC BẢNG:
    -- Chỉ trả về thông báo lỗi nghiệp vụ đã được kiểm soát (khi SQLSTATE = 'P0001' từ RAISE EXCEPTION)
    -- Các lỗi hệ thống khác trả về thông báo chung để không lộ schema
    IF SQLSTATE = 'P0001' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', SQLERRM,
        'code', SQLSTATE
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Hệ thống đang bận hoặc dữ liệu giao dịch không hợp lệ, vui lòng thử lại sau.',
        'code', SQLSTATE
      );
    END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_checkout FROM public;
GRANT EXECUTE ON FUNCTION public.process_checkout TO anon, authenticated, service_role;

-- ==============================================================================
-- 10. HƯỚNG DẪN THIẾT LẬP TÀI KHOẢN ADMIN ĐẦU TIÊN
-- ==============================================================================
-- Sau khi người dùng đăng ký tài khoản qua web:
-- Chạy lệnh sau để thăng cấp tài khoản thành Quản trị viên:
-- 
-- UPDATE public.profiles 
-- SET role = 'admin' 
-- WHERE email = 'admin@mocnha.vn';
