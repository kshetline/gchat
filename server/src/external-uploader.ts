import * as puppeteer from 'puppeteer';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { sleep, toNumber } from '@tubular/util';
import express from 'express';
import { isShuttingDown, reportUploadProgress } from './app.js';
import { restartLocalSocksProxy, startLocalSocksProxy } from './socks-proxy.js';
import { extractIp } from './chat-util.js';

const PROXY_UPDATE_INTERVAL = 7200000; // 2 hours
const UPLOAD_API_FILES_URL = process.env.UPLOAD_API_FILES_URL;
const UPLOAD_API_FOLDER = process.env.UPLOAD_API_FOLDER;
const UPLOAD_API_PAGE_SIZE = 100; // API maximum
const UPLOAD_API_DEFAULT_EXPIRY = 604800; // 1 week (allowed: 0 = never, 3600, 86400, 604800, 2592000)

type MFile = Express.Multer.File;

let browser: puppeteer.Browser;
let page: puppeteer.Page;
let inInit = false;
let proxyPort: number;
let lastProxyUpdate = Date.now();
export let proxyIp: string;

export async function initExternalUploader(force = false, newProxy = false): Promise<void> {
  if (inInit) return new Promise<void>(resolve => {
    const interval = setInterval(() => {
      if (!inInit || isShuttingDown()) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });

  if (browser && page && !force) return;

  inInit = true;

  let done = false;
  let error: string;

  for (let i = 0; i < 3; ++i) {
    try {
      if (page) await page.close();
      page = undefined;
      if (browser) await browser.close();
      browser = undefined;

      if (!proxyPort)
        proxyPort = await startLocalSocksProxy();
      else if (newProxy) {
        proxyPort = 0;
        proxyPort = await restartLocalSocksProxy();
      }

      const options: puppeteer.LaunchOptions = {
        args: [`--proxy-server=socks5://127.0.0.1:${proxyPort}`],
      };

      if (process.env.CHROME_PATH) {
        options.executablePath = process.env.CHROME_PATH;
        options.args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
      }

      browser = await puppeteer.launch(options);
      page = await browser.newPage();
      await page.goto(process.env.GET_IP_SERVICE);
      proxyIp = extractIp(await page.content());
      await page.goto(process.env.EXTERNAL_UPLOADER);
      console.info('External uploader initialized: ' + proxyIp);
      done = true;
      break;
    }
    catch (e) {
      try { await page?.close(); } catch {} // eslint-disable-line @stylistic/brace-style
      page = undefined;
      try { await browser?.close(); } catch {} // eslint-disable-line @stylistic/brace-style
      browser = undefined;
      newProxy = true;
      error = (e as any).message || e.toString();
    }
  }

  inInit = false;

  if (!done)
    throw new Error('Failed to initialize external uploader' + (error ? ': ' + error : ''));
}

export async function getExternalUploadLink(req: express.Request, file: MFile): Promise<string> {
  let uploaderReady = false;

  try {
    if (Date.now() - lastProxyUpdate > PROXY_UPDATE_INTERVAL) {
      lastProxyUpdate = Date.now();
      await initExternalUploader(true, true);
    }
    else
      await initExternalUploader();

    uploaderReady = !!page;
  }
  catch {}

  if (!uploaderReady || isShuttingDown())
    throw new Error('External uploader not available');

  const fileBuffer = await readFile(file.path);
  const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

  await page.reload();
  const buttons = await page.$$('button.timeSelector');
  // '72h' is not a proper ID, so selecting for it is a bit of a hack
  for (const button of buttons) {
    if ((await page.evaluate(button => button.getAttribute('id'), button)) === '72h') {
      await button.click();
      break;
    }
  }

  // Initialize accumulator in the browser
  // @ts-ignore
  await page.evaluate(() => { (window as any).__fileChunks = []; });

  // Send one chunk at a time to stay well under the CDP JSON size limit
  for (let i = 0; i < fileBuffer.length; i += CHUNK_SIZE) {
    const chunk = fileBuffer.subarray(i, i + CHUNK_SIZE).toString('base64');
    // @ts-ignore
    await page.evaluate((chunk: string) => { (window as any).__fileChunks.push(chunk); }, chunk);
  }

  // Assemble and dispatch — no large data crosses the CDP boundary here
  await page.evaluate(
    ({ filename, mimetype, selector }) => {
      // @ts-ignore
      const chunks: string[] = (window as any).__fileChunks;
      // @ts-ignore
      delete (window as any).__fileChunks;

      // Decode each base64 chunk separately to avoid creating a giant string
      const blobParts: Uint8Array[] = chunks.map(chunk => {
        const binary = atob(chunk);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
          bytes[i] = binary.charCodeAt(i);
        return bytes;
      });

      // @ts-ignore
      const file = new File(blobParts, filename, { type: mimetype });
      // @ts-ignore
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      // @ts-ignore
      const input = document.querySelector(selector);
      // @ts-ignore
      input.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true }));
    },
    { filename: file.originalname, mimetype: file.mimetype, selector: '#dropzoneUpload' }
  );

  let link: string;
  let error: string;
  let lastProgress = 0;
  let lackOfProgress = 0;

  do {
    try {
      await page.waitForSelector('div.dz-preview.dz-complete :is(.responseText, .dz-error-message, .dz-progress)',
        { timeout: 5000 });
    }
    catch {}

    let progress = lastProgress;

    try {
      const style = await page.$$eval('div.dz-progress > span.dz-upload', el => el.map(x => x.getAttribute('style')));
      const $ = /width:\s*([.0-9]+)%/.exec(style[0]);

      if ($) {
        progress = toNumber($[1]);
        reportUploadProgress(req, progress);
      }
    }
    catch {}

    if (progress === lastProgress)
      ++lackOfProgress;
    else {
      lastProgress = progress;
      lackOfProgress = 0;
    }

    try {
      link = await page.$eval('div.dz-preview.dz-success .responseText span', el => el.innerText);
    }
    catch {}

    if (!link) {
      try {
        error = await page.$eval('div.dz-preview.dz-complete .dz-error-message', el => el.innerText);

        if (error.startsWith('<'))
          error = error.replace(/<p>/g, '\n').replace(/<style[^>]*>.*?<\/style>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/ +/g, ' ');

        if (error.length > 252)
          error = error.substring(0, 252) + '...';
      }
      catch {}
    }

    if (!link && !error)
      await sleep(5000);
  } while (!link && !error && lackOfProgress < 8);

  if (!error && !link)
    error = 'Upload stalled for unknown reason';

  reportUploadProgress(req, 0);

  if (link)
    return link;

  initExternalUploader(true).catch();
  throw new Error('External uploader: ' + (error || 'failed to upload file'));
}

function uploadApiHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.UPLOAD_API_KEY}` };
}

async function getUploadApiFileNames(): Promise<Set<string>> {
  const names = new Set<string>();

  for (let pageNum = 1; ; ++pageNum) {
    const response = await axios.get(UPLOAD_API_FILES_URL, {
      headers: uploadApiHeaders(),
      params: { page: pageNum, per_page: UPLOAD_API_PAGE_SIZE }
    });
    const data = response.data;
    // The list response shape isn't documented, so accept a bare array or a few likely wrapper fields.
    const files: any[] = Array.isArray(data) ? data : data?.files ?? data?.data ?? data?.items ?? [];
    const lastSize = names.size;

    files.forEach(f => f?.name && names.add(f.name));

    // Stop on a short page, or if the server seems to be ignoring the page parameter.
    if (files.length < UPLOAD_API_PAGE_SIZE || names.size === lastSize)
      break;
  }

  return names;
}

async function getUniqueUploadApiFileName(originalName: string): Promise<string> {
  const existing = await getUploadApiFileNames();
  const ext = extname(originalName).toLowerCase();
  let name: string;

  do {
    name = randomBytes(12).toString('hex').toUpperCase() + ext;
  } while (existing.has(name));

  return name;
}

export async function getUploadApiUploadLink(req: express.Request, file: MFile,
                                          expiry = UPLOAD_API_DEFAULT_EXPIRY): Promise<string> {
  if (!process.env.UPLOAD_API_KEY)
    throw new Error('Upload API: no API key configured');

  let link: string;
  let error: string;

  try {
    const form = new FormData();
    const fileName = await getUniqueUploadApiFileName(file.originalname);

    form.append('file', await openAsBlob(file.path, { type: file.mimetype }), fileName);
    form.append('expiry', expiry.toString());
    form.append('folder', UPLOAD_API_FOLDER);

    const response = await axios.post(UPLOAD_API_FILES_URL, form, {
      headers: uploadApiHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      onUploadProgress: evt => {
        if (evt.total)
          reportUploadProgress(req, evt.loaded * 100 / evt.total);
      }
    });

    link = response.data?.url;

    if (!link)
      error = 'No link returned';
  }
  catch (e) {
    const data = (e as any).response?.data;

    error = data?.message || data?.error || (e as any).message || e.toString();
  }

  reportUploadProgress(req, 0);

  if (link)
    return link;

  throw new Error('Upload API:' + (error || 'failed to upload file'));
}
