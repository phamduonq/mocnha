-- ==============================================================================
-- webhook-and-audit.sql
-- 1. BẢNG AUDIT_LOGS BẤT BIẾN (APPEND-ONLY AUDIT LOGGING) & TRIGGER TỰ ĐỘNG
--    - Tinh chỉnh an toàn trong mọi ngữ cảnh (PostgREST, Worker, Cron, Seed/Migration)
--    - Loại bỏ truy vấn bảng profiles tránh đệ quy RLS & deadlock
-- 2. BẢNG PAYMENT_WEBHOOK_EVENTS & RPC PROCESS_VERIFIED_PAYMENT_WEBHOOK (ANTI-REPLAY)
-- ==============================================================================

-- ==============================================================================
-- PHẦN I: NHẬT KÝ KIỂM TOÁN BẤT BIẾN (APPEND-ONLY AUDIT LOGS)
-- ==============================================================================

-- 1.1. BẢNG AUDIT_LOGS
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID,                                      -- Lấy từ auth.uid() (NULL nếu là background worker/cron)
    actor_role TEXT,                                    -- Lấy từ JWT claims hoặc current_user
    action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    table_name TEXT NOT NULL,
    record_id UUID NOT NULL,
    old_data JSONB,
    new_data JSONB,
    changed_fields TEXT[],                              -- Danh sách các cột bị thay đổi khi UPDATE
    client_ip TEXT,                                     -- Lấy từ request header x-forwarded-for
    user_agent TEXT,                                    -- Lấy từ request header user-agent
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index tối ưu hóa truy vấn kiểm toán
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON public.audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

-- 1.2. THIẾT LẬP RLS TRÊN AUDIT_LOGS: CHỈ CHO PHÉP ADMIN ĐƯỢC XEM (SELECT)
-- Tuyệt đối KHÔNG cấp quyền UPDATE hay DELETE cho bất kỳ ai (kể cả Admin)
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view audit logs" ON public.audit_logs;
CREATE POLICY "Admins can view audit logs"
ON public.audit_logs
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1 
        FROM public.profiles 
        WHERE id = auth.uid() AND role = 'admin'
    )
);

-- 1.3. KHÓA VẬT LÝ APPEND-ONLY BẰNG TRIGGER CHỐNG SỬA/XÓA/TRUNCATE LOG
CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: Audit logs are append-only and cannot be modified or deleted'
    USING ERRCODE = '55000'; -- Object not in prerequisite state
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_audit_log_update_delete ON public.audit_logs;
CREATE TRIGGER trg_prevent_audit_log_update_delete
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.prevent_audit_log_modification();

DROP TRIGGER IF EXISTS trg_prevent_audit_log_truncate ON public.audit_logs;
CREATE TRIGGER trg_prevent_audit_log_truncate
BEFORE TRUNCATE ON public.audit_logs
FOR EACH STATEMENT
EXECUTE FUNCTION public.prevent_audit_log_modification();

-- 1.4. TRIGGER FUNCTION TỰ ĐỘNG GHI AUDIT LOG (TINH CHỈNH AN TOÀN TRONG MỌI NGỮ CẢNH)
CREATE OR REPLACE FUNCTION public.record_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_actor_id UUID;
    v_actor_role TEXT;
    v_headers JSONB;
    v_client_ip TEXT := NULL;
    v_user_agent TEXT := NULL;
    v_record_id UUID;
    v_old_data JSONB := NULL;
    v_new_data JSONB := NULL;
    v_changed_fields TEXT[] := NULL;
BEGIN
    -- 1. Trích xuất danh tính Actor an toàn (Không làm chết transaction nếu hàm auth không tồn tại)
    BEGIN
        v_actor_id := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_actor_id := NULL;
    END;
    
    -- 2. Trích xuất Email hoặc Role an toàn từ JWT claims hoặc current_user
    -- Ưu tiên lấy email để Admin dễ dàng kiểm tra danh tính trong trang Nhật ký kiểm toán
    -- TUYỆT ĐỐI KHÔNG query bảng public.profiles để tránh đệ quy RLS, vòng lặp quyền hoặc deadlock khi chạy ngầm
    BEGIN
        v_actor_role := COALESCE(auth.jwt()->>'email', auth.jwt()->>'role', current_user);
    EXCEPTION WHEN OTHERS THEN
        v_actor_role := current_user;
    END;

    -- 3. Trích xuất IP và User-Agent an toàn trong mọi ngữ cảnh (PostgREST, Worker, Migration, CLI)
    -- Bọc trong khối kiểm tra an toàn: nếu setting không tồn tại hoặc lỗi cú pháp JSON, tự động nhận NULL
    BEGIN
        v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
        IF v_headers IS NOT NULL THEN
            v_client_ip := v_headers->>'x-forwarded-for';
            v_user_agent := v_headers->>'user-agent';
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_client_ip := NULL;
        v_user_agent := NULL;
    END;

    -- 4. Phân loại thao tác dữ liệu
    IF TG_OP = 'INSERT' THEN
        v_record_id := NEW.id;
        v_new_data := to_jsonb(NEW);
    ELSIF TG_OP = 'DELETE' THEN
        v_record_id := OLD.id;
        v_old_data := to_jsonb(OLD);
    ELSIF TG_OP = 'UPDATE' THEN
        v_record_id := NEW.id;
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);

        -- Nếu dữ liệu cũ và mới giống hệt nhau -> Bỏ qua không ghi log thừa
        IF v_old_data = v_new_data THEN
            RETURN NEW;
        END IF;

        -- Tính toán danh sách các cột thực sự bị thay đổi
        SELECT array_agg(key) INTO v_changed_fields
        FROM jsonb_each(v_new_data)
        WHERE (v_new_data -> key) IS DISTINCT FROM (v_old_data -> key);

        -- Nếu không có trường nào thay đổi -> Bỏ qua
        IF v_changed_fields IS NULL OR array_length(v_changed_fields, 1) = 0 THEN
            RETURN NEW;
        END IF;
    END IF;

    -- 5. Chèn bản ghi nhật ký kiểm toán bất biến
    INSERT INTO public.audit_logs (
        actor_id,
        actor_role,
        action,
        table_name,
        record_id,
        old_data,
        new_data,
        changed_fields,
        client_ip,
        user_agent,
        created_at
    ) VALUES (
        v_actor_id,
        v_actor_role,
        TG_OP,
        TG_TABLE_NAME,
        v_record_id,
        v_old_data,
        v_new_data,
        v_changed_fields,
        v_client_ip,
        v_user_agent,
        now()
    );

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

-- 1.5. GẮN TRIGGER VÀO BẢNG PRODUCTS VÀ ORDERS
DROP TRIGGER IF EXISTS trg_audit_products ON public.products;
CREATE TRIGGER trg_audit_products
AFTER INSERT OR UPDATE OR DELETE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.record_audit_log();

DROP TRIGGER IF EXISTS trg_audit_orders ON public.orders;
CREATE TRIGGER trg_audit_orders
AFTER INSERT OR UPDATE OR DELETE ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.record_audit_log();


-- ==============================================================================
-- PHẦN II: PAYMENT WEBHOOK EVENTS & XỬ LÝ THANH TOÁN (ANTI-REPLAY RPC)
-- ==============================================================================

-- 2.1. BẢNG PAYMENT_WEBHOOK_EVENTS
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
    event_id TEXT PRIMARY KEY,                          -- ID duy nhất từ cổng thanh toán (chống Replay)
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                             -- Cổng thanh toán (VNPAY, MOMO, STRIPE,...)
    amount NUMERIC(12, 0) NOT NULL,                     -- Số tiền thanh toán thực tế
    payload JSONB NOT NULL,                             -- Raw payload đầy đủ từ webhook
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhooks_order_id ON public.payment_webhook_events(order_id);

-- Khóa RLS trên bảng webhook events: Cấm hoàn toàn mọi quyền từ client (anon / authenticated)
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

-- 2.2. RPC TRANSACTION XỬ LÝ WEBHOOK THANH TOÁN NGUYÊN TỬ
CREATE OR REPLACE FUNCTION public.process_verified_payment_webhook (
    p_event_id TEXT,
    p_order_id UUID,
    p_provider TEXT,
    p_amount NUMERIC,
    p_raw_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_order RECORD;
BEGIN
    -- 1. CHỐNG REPLAY ATTACK: Thử lưu event_id vào bảng webhook events
    INSERT INTO public.payment_webhook_events (event_id, order_id, provider, amount, payload, processed_at)
    VALUES (p_event_id, p_order_id, p_provider, p_amount, p_raw_payload, now())
    ON CONFLICT (event_id) DO NOTHING;

    -- Nếu không insert được -> Sự kiện này đã được xử lý thành công trước đó (Idempotent replay)
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'is_duplicate', true,
            'event_id', p_event_id,
            'order_id', p_order_id,
            'message', 'Webhook event has already been processed.'
        );
    END IF;

    -- 2. KHÓA DÒNG ĐƠN HÀNG (FOR UPDATE) ĐỂ THAO TÁC AN TOÀN
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND: Order with ID % does not exist', p_order_id
        USING ERRCODE = 'P0002';
    END IF;

    -- 3. KIỂM TRA SỐ TIỀN THANH TOÁN: Phải khớp 100% với total_amount của đơn hàng
    IF v_order.total_amount != p_amount THEN
        RAISE EXCEPTION 'AMOUNT_MISMATCH: Paid amount (%) does not match order total (%)',
            p_amount, v_order.total_amount
        USING ERRCODE = '22023';
    END IF;

    -- 4. CẬP NHẬT TRẠNG THÁI ĐƠN HÀNG NẾU ĐANG LÀ PENDING
    -- Thao tác UPDATE này sẽ tự động kích hoạt Trigger trg_audit_orders ghi vào bảng audit_logs!
    IF v_order.status = 'pending' THEN
        UPDATE public.orders
        SET status = 'paid',
            updated_at = now()
        WHERE id = p_order_id;
    END IF;

    RETURN jsonb_build_object(
        'is_duplicate', false,
        'event_id', p_event_id,
        'order_id', p_order_id,
        'status', 'paid',
        'amount', p_amount,
        'processed_at', now()
    );
END;
$$;

-- 2.3. PHÂN QUYỀN HÀM CHẶT CHẼ
-- Chỉ duy nhất service_role (Backend Webhook server) mới được thực thi hàm này
REVOKE ALL ON FUNCTION public.process_verified_payment_webhook(TEXT, UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_verified_payment_webhook(TEXT, UUID, TEXT, NUMERIC, JSONB) TO service_role;
