/**
 * Cloudinary SDK — server-side video storage.
 * Videos are uploaded from the browser → this server (multer) → Cloudinary.
 */

const { v2: cloudinary } = require('cloudinary');

let configured = false;

function initCloudinary() {
  if (configured) return cloudinary;

  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.warn('[cloudinary] Missing credentials, uploads will fail');
    return null;
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });

  configured = true;
  console.log('[cloudinary] Configured ✅');
  return cloudinary;
}

/**
 * Upload a video file (from multer) to Cloudinary.
 * @param {Buffer} buffer
 * @param {{ folder?: string, publicId?: string }} options
 * @returns {Promise<{ secure_url: string, public_id: string, duration: number, format: string, bytes: number }>}
 */
function uploadVideoBuffer(buffer, { folder = 'remote-video-controller/videos' } = {}) {
  const client = initCloudinary();
  if (!client) throw new Error('Cloudinary not configured');

  return new Promise((resolve, reject) => {
    const stream = client.uploader.upload_stream(
      {
        resource_type: 'video',
        folder,
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/**
 * Delete a video from Cloudinary by its public_id.
 * @param {string} publicId
 */
async function deleteVideo(publicId) {
  const client = initCloudinary();
  if (!client) throw new Error('Cloudinary not configured');

  return client.uploader.destroy(publicId, { resource_type: 'video' });
}

/**
 * Build a thumbnail URL for a Cloudinary video.
 * Replaces `.mp4` with `.jpg` and injects a transformation.
 */
function buildThumbnailUrl(secureUrl) {
  if (!secureUrl) return null;
  return secureUrl
    .replace('/video/upload/', '/video/upload/so_1,w_640,h_360,c_fill/')
    .replace(/\.(mp4|webm|mov|avi|mkv)$/i, '.jpg');
}

module.exports = {
  initCloudinary,
  uploadVideoBuffer,
  deleteVideo,
  buildThumbnailUrl,
};