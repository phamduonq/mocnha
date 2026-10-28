-- ==============================================================================
-- storage-rls.sql
-- Cấu hình bảo mật Supabase Storage và Row Level Security (RLS)
-- Bucket: user_uploads
-- ==============================================================================

-- 1. TẠO BUCKET 'user_uploads' VÀ CẤU HÌNH RÀO CẢN BẢO MẬT
-- Giới hạn cứng dung lượng tệp: 5242880 bytes (5MB)
-- Giới hạn loại MIME: image/jpeg, image/png, image/webp (Cấm tuyệt đối SVG)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'user_uploads',
    'user_uploads',
    false, -- Bucket ở chế độ Private (Truy cập qua signed URL hoặc RLS policy)
    5242880, -- 5MB = 5 * 1024 * 1024
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- 2. KÍCH HOẠT ROW LEVEL SECURITY (RLS) TRÊN BẢNG storage.objects
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3. XÓA CÁC POLICY CŨ LIÊN QUAN ĐẾN BUCKET user_uploads ĐỂ TRÁNH TRÙNG LẶP
DROP POLICY IF EXISTS "Authenticated users can upload to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read own files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update own files" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete own files" ON storage.objects;

-- 4. THIẾT LẬP RLS POLICY - QUYỀN INSERT
-- Chỉ Authenticated Users mới có quyền tạo tệp.
-- BẮT BUỘC đường dẫn tệp phải nằm trong thư mục trùng với auth.uid() của chính họ:
-- Cấu trúc hợp lệ: user_uploads/<auth.uid()>/<file_name>.webp
CREATE POLICY "Authenticated users can upload to own folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = (auth.uid())::text
);

-- 5. THIẾT LẬP RLS POLICY - QUYỀN SELECT (ĐỌC)
-- Người dùng chỉ được phép đọc và lấy file trong thư mục của chính họ
CREATE POLICY "Authenticated users can read own files"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = (auth.uid())::text
);

-- 6. THIẾT LẬP RLS POLICY - QUYỀN UPDATE (CHỈNH SỬA)
-- Người dùng chỉ được cập nhật metadata/file trong thư mục của chính họ
CREATE POLICY "Authenticated users can update own files"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = (auth.uid())::text
)
WITH CHECK (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = (auth.uid())::text
);

-- 7. THIẾT LẬP RLS POLICY - QUYỀN DELETE (XÓA)
-- Người dùng chỉ được phép xóa các file do chính mình sở hữu
CREATE POLICY "Authenticated users can delete own files"
ON storage.objects
FOR DELETE
TO authenticated
USING (
    bucket_id = 'user_uploads'
    AND (storage.foldername(name))[1] = (auth.uid())::text
);
