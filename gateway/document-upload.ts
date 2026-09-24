import multer from 'multer';
import { extname } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../core/ingestion-limits.js';
import { extensions } from '../data/ingestion/extract.js';
export const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 },
  fileFilter: (_req, file, callback) => callback(null, extensions.includes(extname(file.originalname).toLowerCase())) }).single('file');
