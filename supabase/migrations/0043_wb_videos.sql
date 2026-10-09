-- 0043_wb_videos.sql
--   Videos on Miro boards: MP4, WebM and MOV files go in the same private
--   'whiteboard' bucket as images (same read / upload rules from 0038). The
--   limit goes up to 50 MB for them; the app still caps images at 15 MB.
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/gif', 'image/webp',
                                  'video/mp4', 'video/webm', 'video/quicktime']
 where id = 'whiteboard';
