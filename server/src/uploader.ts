import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import { SessionInfo } from './session-info';
import { HtmlParser,  } from 'fortissimo-html';

const domain = process.env.CHAT_DOMAIN;
const parser = new HtmlParser();
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

  return ''
}

export async function uploadSingle(session: SessionInfo,
    req: express.Request, res: express.Response): Promise<string>
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
  const pwd = req.body.password;

  if (!page) {
    page = session.uploaderPage = await session.context.newPage();
    await page.goto(`http://${domain}/up.php`);
    await page.waitForSelector('form');
  }

  const fileInput = await page.waitForSelector('input[type="file"]');
  await fileInput.uploadFile(file.path);
  await page.$eval('input[name="password"]', (input, pwd) => input.value = pwd, pwd || '');
  const comment = 'chat-paste-' + new Date().toISOString() + '-' + (++fileIndex);
  await page.$eval('#comment', (input, comment) => input.value = comment, comment);
  await page.$eval('button[type="submit"]', btn => btn.click());

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.$eval('button[type="submit"]', btn => btn.click())
  ]);

  try {
    await fs.unlink(file.path);
  }
  catch (err) {}

  return extractLinkFromPageContent(await page.content(), comment);
}

