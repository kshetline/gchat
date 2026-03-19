import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import { SessionInfo } from './session-info';

const domain = process.env.CHAT_DOMAIN;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const uploadDir = path.join(os.tmpdir(), 'uploads');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    }
    catch (error) {
      cb(error as Error, uploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const uniqueName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (_req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

export async function uploadSingle(session: SessionInfo,
    req: express.Request, res: express.Response): Promise<Express.Multer.File>
{
  const file = await new Promise<Express.Multer.File> ((resolve, reject) => {
    upload.single('image')(req, res, (err) => {
      if (err)
        reject(err);
      else if (!req.file)
        reject(new Error('No file uploaded'));
      else
        resolve(req.file);
    });
  });

  let page = session.uploaderPage;

  if (!page) {
    page = session.uploaderPage = await session.context.newPage();
    await page.goto(`http://${domain}/up.php`);
    await page.waitForSelector('form');
  }

  return file;
}

