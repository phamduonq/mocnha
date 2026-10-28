-- ==============================================================================
-- vector-db.sql
-- Cấu hình CSDL Vector Cách ly (Supabase pgvector) cho AI Chatbot
-- Bản cập nhật: SECURITY INVOKER + Tường minh search_path chống privilege escalation
-- ==============================================================================

-- 1. KÍCH HOẠT EXTENSION PGVECTOR TRÊN SUPABASE
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. TẠO BẢNG CHATBOT_KNOWLEDGE_BASE ĐỘC LẬP
-- Bảng này CHỈ lưu dữ liệu thông tin tri thức tĩnh phục vụ RAG.
-- Tuyệt đối KHÔNG chứa khóa ngoại (Foreign Key) hay liên kết trực tiếp tới bảng giao dịch.
CREATE TABLE IF NOT EXISTS public.chatbot_knowledge_base (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,                          -- Nội dung văn bản mô tả sản phẩm, chính sách, hướng dẫn
    metadata JSONB DEFAULT '{}'::jsonb,             -- Thông tin tham khảo: {"product_id": "...", "category": "..."}
    embedding vector(768) NOT NULL,                 -- Vector 768 chiều tương thích chuẩn model text-embedding-004 của Google
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

COMMENT ON TABLE public.chatbot_knowledge_base IS 'Bảng tri thức cách ly dành riêng cho AI Chatbot RAG. Không có quyền ghi từ phía người dùng.';

-- 3. TẠO INDEX HNSW TỐI ƯU TÌM KIẾM COSINE SIMILARITY
CREATE INDEX IF NOT EXISTS chatbot_knowledge_base_embedding_hnsw_idx
ON public.chatbot_knowledge_base
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 4. KÍCH HOẠT ROW LEVEL SECURITY (RLS)
ALTER TABLE public.chatbot_knowledge_base ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read-only access to chatbot knowledge" ON public.chatbot_knowledge_base;

-- CHỈ CHO PHÉP ĐỌC (SELECT) công khai:
CREATE POLICY "Public read-only access to chatbot knowledge"
ON public.chatbot_knowledge_base
FOR SELECT
TO anon, authenticated
USING (true);

-- 5. FUNCTION SQL: MATCH_DOCUMENTS (CHUẨN HÓA BẢO MẬT POSTGRESQL)
-- THAY ĐỔI QUAN TRỌNG:
-- - SECURITY INVOKER: Bắt buộc hàm chạy theo quyền của role đang gọi (tuân thủ RLS Policy, không bypass).
-- - SET search_path = public, extensions: Cố định search_path để triệt tiêu nguy cơ search_path hijacking.
CREATE OR REPLACE FUNCTION public.match_documents (
    query_embedding vector(768),                    -- Vector câu hỏi người dùng
    match_threshold float DEFAULT 0.4,              -- Ngưỡng tương đồng tối thiểu (0.0 đến 1.0)
    match_count int DEFAULT 3                       -- Giới hạn số lượng tài liệu liên quan nhất
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    metadata JSONB,
    similarity float
)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
    RETURN QUERY
    SELECT
        kb.id,
        kb.content,
        kb.metadata,
        (1 - (kb.embedding <=> query_embedding))::float AS similarity
    FROM public.chatbot_knowledge_base kb
    WHERE (1 - (kb.embedding <=> query_embedding)) >= match_threshold
    ORDER BY kb.embedding <=> query_embedding ASC
    LIMIT match_count;
END;
$$;
