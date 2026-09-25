import multer from 'multer';
import { extname } from 'node:path';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from '../core/ingestion-limits.js';
import { extensions } from '../data/ingestion/extract.js';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES, fields: 2 },
  fileFilter: (_req, file, callback) => callback(null, extensions.includes(extname(file.originalname).toLowerCase())) }).single('file');
export const documentUpload = upload;
export const documentUploads = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES, fields: 2 },
  fileFilter: (_req, file, callback) => callback(null, extensions.includes(extname(file.originalname).toLowerCase())) }).array('files', MAX_UPLOAD_FILES);
