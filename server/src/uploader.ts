import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import { HtmlParser  } from 'fortissimo-html';
import { toBoolean, toInt } from '@tubular/util';
import { allowedExtensions, allowedTypes, MB } from './shared-types.js';
import * as puppeteer from 'puppeteer';
import { browser } from './legacy.js';
import { getExternalUploadLink } from './external-uploader.js';

type MFile = Express.Multer.File;

const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();
let uploadPage: puppeteer.Page;
let fileIndex = 0;

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

function getUploader(external = false): multer.Multer {
  return multer({
    storage: storage,
    limits: { fileSize: toInt(external ? process.env.EXT_UPLOAD_MAX_SIZE_MB : process.env.UPLOAD_MAX_SIZE_MB) * MB },
    fileFilter: (_req, file, cb) => {
      const extname = allowedExtensions.test(path.extname(file.originalname).toLowerCase());
      const mimetype = allowedTypes.test(file.mimetype);

      if (mimetype || extname)
        cb(null, true);
      else
        cb(new Error('Not an allowed file type.'));
    }
  });
}

function extractLinkFromPageContent(content: string, comment: string): string  {
  const dom = parser.parse(content).domRoot;
  const body = dom.querySelector('body');
  const tableRows = body?.querySelectorAll('tr');

  for (const row of tableRows || []) {
    const cells = row.querySelectorAll('td');

    if (cells[2]?.textContent === comment) {
      const url = cells[1].querySelector('a')?.getAttribute('href')[1] || '';

      if (url)
        return `https://${domain}/${url}`;
    }
  }

  return '';
}

export async function uploadSingle(req: express.Request, res: express.Response): Promise<string> {
  const external = toBoolean(req.query.external);
  const file = await new Promise<MFile> ((resolve, reject) => {
    getUploader(external).single('image')(req, res, err => {
      if (err)
        reject(err as Error);
      else if (!req.file)
        reject(new Error('No file uploaded'));
      else
        resolve(req.file);
    });
  });

  if (external)
    return await getExternalUploadLink(req, file);

  const pwd = req.body.password;

  if (!uploadPage) {
    uploadPage = uploadPage = await browser.newPage();
    await uploadPage.goto(`https://${domain}/up.php`);
    await uploadPage.waitForSelector('form');
  }

  const fileInput = await uploadPage.waitForSelector('input[type="file"]');
  await fileInput.uploadFile(file.path);
  await uploadPage.$eval('input[name="password"]', (input, pwd) => input.value = pwd, pwd || '');
  const comment = `${req.body.name || 'x'}-paste-` + new Date().toISOString().substring(0, 19) + '-' + (++fileIndex);
  await uploadPage.$eval('#comment', (input, comment) => input.value = comment, comment);
  await uploadPage.$eval('button[type="submit"]', btn => btn.click());

  await Promise.all([
    uploadPage.waitForNavigation({ waitUntil: 'networkidle0' }),
    uploadPage.$eval('button[type="submit"]', btn => btn.click())
  ]);

  try {
    await fs.unlink(file.path);
  }
  catch {}

  return extractLinkFromPageContent(await uploadPage.content(), comment);
}
