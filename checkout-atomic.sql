-- ==============================================================================
-- checkout-atomic.sql
-- Kiến trúc Thanh toán Nguyên tử (Atomic Checkout) & Pessimistic Locking
-- Bản vá: SECURITY DEFINER, lock_timeout = 3s, Check Constraint stock >= 0,
-- Validate đầu vào trực tiếp trong SQL, chuẩn hóa NULL logic & Revoke/Grant.
-- ==============================================================================

-- 1. RÀNG BUỘC CỨNG Ở TẦNG BẢNG: ĐẢM BẢO TỒN KHO KHÔNG BAO GIỜ ÂM
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_stock_non_negative;
ALTER TABLE public.products ADD CONSTRAINT products_stock_non_negative CHECK (stock >= 0);

-- 2. BẢNG IDEMPOTENCY_KEYS
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,                         -- SHA-256 của payload giỏ hàng
    status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    response_code INT,                                  -- HTTP Status Code (200, 201)
    response_body JSONB,                                -- Kết quả trả về đã lưu của đơn hàng
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user_id ON public.idempotency_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON public.idempotency_keys(expires_at);

-- 3. THIẾT LẬP ROW LEVEL SECURITY (RLS) TRÊN IDEMPOTENCY_KEYS
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own idempotency keys" ON public.idempotency_keys;
CREATE POLICY "Users can manage own idempotency keys"
ON public.idempotency_keys
FOR ALL
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- 4. STORED PROCEDURE NGUYÊN TỬ: PROCESS_ATOMIC_CHECKOUT
-- Chạy với SECURITY DEFINER để có quyền khóa và trừ kho products mà không cần cấp quyền UPDATE cho client
CREATE OR REPLACE FUNCTION public.process_atomic_checkout (
    p_idempotency_key UUID,
    p_request_hash TEXT,
    p_items JSONB,
    p_shipping_address TEXT,
    p_payment_method TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- Thực thi với quyền của function owner để thao tác bảng products an toàn
SET search_path = public, extensions -- Cố định search_path triệt tiêu nguy cơ chiếm quyền
AS $$
DECLARE
    v_user_id UUID;
    v_idempotency_record RECORD;
    v_profile RECORD;
    v_customer_name TEXT;
    v_customer_phone TEXT;
    v_customer_email TEXT;
    v_product RECORD;
    v_total_amount NUMERIC(12, 0) := 0;
    v_order_id UUID;
    v_response_data JSONB;
    v_raw_item_count INT;
    v_unique_item_count INT;
    v_found_product_count INT;
    v_item JSONB;
    v_clean_shipping_address TEXT;
    v_clean_payment_method TEXT;
BEGIN
    -- 0. THIẾT LẬP LOCK TIMEOUT 3 GIÂY CHỐNG TREO HỆ THỐNG / DEADLOCK WAIT
    -- Nếu không giành được khóa FOR UPDATE sau 3s, PostgreSQL tự động hủy lệnh và ném lỗi 55P03
    SET LOCAL lock_timeout = '3s';

    -- 1. XÁC MINH DANH TÍNH NGƯỜI DÙNG (AUTH.UID())
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'UNAUTHORIZED: User must be authenticated to checkout' USING ERRCODE = '28000';
    END IF;

    -- 2. VALIDATE ĐẦU VÀO TRỰC TIẾP TRONG SQL (CHỐNG BYPASS NODE.JS GỌI THẲNG RPC)
    -- 2.1. Kiểm tra p_shipping_address
    IF p_shipping_address IS NULL THEN
        RAISE EXCEPTION 'INVALID_SHIPPING_ADDRESS: Shipping address is required' USING ERRCODE = '22023';
    END IF;

    v_clean_shipping_address := trim(p_shipping_address);
    IF length(v_clean_shipping_address) < 5 OR length(v_clean_shipping_address) > 500 THEN
        RAISE EXCEPTION 'INVALID_SHIPPING_ADDRESS: Shipping address must be between 5 and 500 characters' USING ERRCODE = '22023';
    END IF;

    -- 2.2. Kiểm tra p_payment_method
    IF p_payment_method IS NULL THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: Payment method is required' USING ERRCODE = '22023';
    END IF;

    v_clean_payment_method := trim(upper(p_payment_method));
    IF v_clean_payment_method NOT IN ('COD', 'BANK_TRANSFER', 'VNPAY', 'MOMO') THEN
        RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: Payment method must be one of COD, BANK_TRANSFER, VNPAY, MOMO' USING ERRCODE = '22023';
    END IF;

    -- 2.3. Kiểm tra cấu trúc p_items (Array, 1 <= count <= 50)
    IF p_items IS NULL OR jsonb_typeof(p_items) != 'array' THEN
        RAISE EXCEPTION 'INVALID_CART_ITEMS: Cart items must be a JSON array' USING ERRCODE = '22023';
    END IF;

    v_raw_item_count := jsonb_array_length(p_items);
    IF v_raw_item_count < 1 OR v_raw_item_count > 50 THEN
        RAISE EXCEPTION 'MAX_CART_ITEMS_EXCEEDED: Cart must contain between 1 and 50 items' USING ERRCODE = '22023';
    END IF;

    -- 2.4. Validate từng phần tử: product_id hợp lệ và quantity từ 1 đến 100 (CHẶN ĐỨNG SỐ LƯỢNG ÂM)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        -- Kiểm tra UUID format
        IF (v_item->>'product_id') IS NULL OR 
           (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION 'INVALID_PRODUCT_ID: Each item must contain a valid UUID product_id' USING ERRCODE = '22023';
        END IF;

        -- Kiểm tra quantity có phải số nguyên hợp lệ
        IF (v_item->>'quantity') IS NULL OR (v_item->>'quantity') !~ '^-?[0-9]+$' THEN
            RAISE EXCEPTION 'INVALID_QUANTITY: Quantity must be an integer between 1 and 100' USING ERRCODE = '22023';
        END IF;

        -- Chặn đứng số lượng âm hoặc vượt quá 100
        IF (v_item->>'quantity')::int < 1 OR (v_item->>'quantity')::int > 100 THEN
            RAISE EXCEPTION 'INVALID_QUANTITY: Quantity must be between 1 and 100' USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- 2.5. Kiểm tra tổng số lượng sau khi gộp từng sản phẩm không được vượt quá 100
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_items) AS it
        GROUP BY (it->>'product_id')::uuid
        HAVING SUM((it->>'quantity')::int) > 100 OR SUM((it->>'quantity')::int) < 1
    ) THEN
        RAISE EXCEPTION 'INVALID_QUANTITY: Total quantity for any product must be between 1 and 100' USING ERRCODE = '22023';
    END IF;

    -- ==========================================================================
    -- BƯỚC 3: KIỂM SOÁT IDEMPOTENCY ĐỒNG THỜI (CHUẨN HÓA LOGIC NULL VỚI IS DISTINCT FROM)
    -- ==========================================================================
    INSERT INTO public.idempotency_keys (key, user_id, request_hash, status)
    VALUES (p_idempotency_key, v_user_id, p_request_hash, 'IN_PROGRESS')
    ON CONFLICT (key) DO NOTHING;

    -- Nếu không chèn được bản ghi -> Key đã tồn tại
    IF NOT FOUND THEN
        SELECT * INTO v_idempotency_record
        FROM public.idempotency_keys
        WHERE key = p_idempotency_key
        FOR UPDATE; -- Khóa bản ghi idempotency chống race condition

        -- SỬA LỖI LOGIC NULL: Sử dụng IS DISTINCT FROM và kiểm tra NOT FOUND
        IF NOT FOUND OR v_idempotency_record.user_id IS DISTINCT FROM v_user_id THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_OWNERSHIP_MISMATCH: Key belongs to another user' USING ERRCODE = '42501';
        END IF;

        IF v_idempotency_record.request_hash IS DISTINCT FROM p_request_hash THEN
            RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: Reusing the same key with different payload' USING ERRCODE = '22000';
        END IF;

        IF v_idempotency_record.status = 'IN_PROGRESS' THEN
            RAISE EXCEPTION 'REQUEST_IN_PROGRESS: Order is currently being processed. Please wait.' USING ERRCODE = '55P03';
        END IF;

        IF v_idempotency_record.status = 'COMPLETED' THEN
            RETURN jsonb_build_object(
                'is_replay', true,
                'response_code', v_idempotency_record.response_code,
                'data', v_idempotency_record.response_body
            );
        END IF;

        -- Nếu status FAILED trước đó, cho phép thử lại
        UPDATE public.idempotency_keys
        SET status = 'IN_PROGRESS',
            response_code = NULL,
            response_body = NULL,
            created_at = now()
        WHERE key = p_idempotency_key;
    END IF;

    -- ==========================================================================
    -- BƯỚC 4: CHỐNG DEADLOCK & PESSIMISTIC LOCKING (FOR UPDATE)
    -- ==========================================================================
    SELECT COUNT(DISTINCT (item->>'product_id')::uuid) INTO v_unique_item_count
    FROM jsonb_array_elements(p_items) AS item;

    SELECT COUNT(*) INTO v_found_product_count
    FROM public.products
    WHERE id IN (
        SELECT DISTINCT (item->>'product_id')::uuid
        FROM jsonb_array_elements(p_items) AS item
    );

    IF v_found_product_count < v_unique_item_count THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND: One or more requested products do not exist' USING ERRCODE = 'P0002';
    END IF;

    -- Khóa các dòng sản phẩm: BẮT BUỘC ORDER BY p.id ASC để triệt tiêu 100% Deadlock!
    FOR v_product IN
        SELECT 
            p.id,
            p.name,
            p.price,
            p.stock,
            p.is_active,
            ci.quantity AS requested_quantity
        FROM (
            SELECT 
                (item->>'product_id')::uuid AS product_id,
                SUM((item->>'quantity')::int)::int AS quantity
            FROM jsonb_array_elements(p_items) AS item
            GROUP BY (item->>'product_id')::uuid
        ) ci
        JOIN public.products p ON p.id = ci.product_id
        ORDER BY p.id ASC
        FOR UPDATE OF p
    LOOP
        IF NOT v_product.is_active THEN
            RAISE EXCEPTION 'PRODUCT_INACTIVE: Product "%" is currently not available', v_product.name USING ERRCODE = '22023';
        END IF;

        -- KIỂM TRA TỒN KHO & TRỪ KHO NGUYÊN TỬ
        IF v_product.stock < v_product.requested_quantity THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK: Product "%" out of stock (Available: %, Requested: %)',
                v_product.name, v_product.stock, v_product.requested_quantity USING ERRCODE = '55P03';
        END IF;

        UPDATE public.products
        SET stock = stock - v_product.requested_quantity,
            updated_at = now()
        WHERE id = v_product.id;

        -- TÍNH TIỀN TẠI SERVER (ZERO CLIENT PRICE TRUST)
        v_total_amount := v_total_amount + (v_product.price * v_product.requested_quantity);
    END LOOP;

    -- ==========================================================================
    -- BƯỚC 5: TẠO ĐƠN HÀNG VÀ LƯU KẾT QUẢ IDEMPOTENCY
    -- ==========================================================================
    SELECT full_name, phone, email INTO v_profile FROM public.profiles WHERE id = v_user_id;
    v_customer_name := COALESCE(v_profile.full_name, 'Khách hàng ' || substr(v_user_id::text, 1, 8));
    v_customer_phone := COALESCE(v_profile.phone, 'Chưa cập nhật');
    v_customer_email := v_profile.email;

    INSERT INTO public.orders (
        user_id,
        customer_name,
        customer_phone,
        customer_email,
        shipping_address,
        total_amount,
        status,
        payment_method
    ) VALUES (
        v_user_id,
        v_customer_name,
        v_customer_phone,
        v_customer_email,
        v_clean_shipping_address,
        v_total_amount,
        'pending',
        v_clean_payment_method
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.order_items (
        order_id,
        product_id,
        product_name,
        quantity,
        unit_price,
        subtotal
    )
    SELECT 
        v_order_id,
        p.id,
        p.name,
        ci.quantity,
        p.price,
        (p.price * ci.quantity)
    FROM (
        SELECT 
            (item->>'product_id')::uuid AS product_id,
            SUM((item->>'quantity')::int)::int AS quantity
        FROM jsonb_array_elements(p_items) AS item
        GROUP BY (item->>'product_id')::uuid
    ) ci
    JOIN public.products p ON p.id = ci.product_id;

    v_response_data := jsonb_build_object(
        'order_id', v_order_id,
        'user_id', v_user_id,
        'total_amount', v_total_amount,
        'status', 'pending',
        'payment_method', v_clean_payment_method,
        'shipping_address', v_clean_shipping_address,
        'items_count', v_unique_item_count,
        'created_at', now()
    );

    UPDATE public.idempotency_keys
    SET status = 'COMPLETED',
        response_code = 201,
        response_body = v_response_data
    WHERE key = p_idempotency_key;

    -- Khi hoàn tất, PostgreSQL commit toàn bộ
    RETURN jsonb_build_object(
        'is_replay', false,
        'response_code', 201,
        'data', v_response_data
    );

    -- Lưu ý: Không sử dụng khối EXCEPTION WHEN OTHERS THEN UPDATE ... RAISE;
    -- Khi có lỗi, toàn bộ transaction tự động ROLLBACK sạch sẽ về trạng thái ban đầu,
    -- giải phóng khóa và cho phép client thực hiện lại request mà không bị kẹt status.
END;
$$;

-- 5. PHÂN QUYỀN HÀM CHẶT CHẼ THEO NGUYÊN TẮC LEAST PRIVILEGE
-- Chỉ cho phép người dùng đã xác thực (authenticated) thực thi hàm checkout
REVOKE ALL ON FUNCTION public.process_atomic_checkout(UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_atomic_checkout(UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated;
