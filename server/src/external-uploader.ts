import * as puppeteer from 'puppeteer';
import axios, { AxiosInstance } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { randomBytes } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { last, toInt, toNumber } from '@tubular/util';
import express from 'express';
import { isShuttingDown, reportUploadProgress } from './app.js';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { extractIp } from './chat-util.js';

const PROXY_UPDATE_INTERVAL = 7200000; // 2 hours
const UPLOAD_API_FILES_URL = process.env.UPLOAD_API_FILES_URL;
const UPLOAD_API_FOLDER = process.env.UPLOAD_API_FOLDER;
const UPLOAD_API_MAX_AGE_SECS = toInt(process.env.UPLOAD_API_MAX_AGE_SECS, 259200);
const UPLOAD_API_MAX_FILES = toInt(process.env.UPLOAD_API_MAX_FILES, 50);
const UPLOAD_API_MAX_TOTAL_SIZE = toInt(process.env.UPLOAD_API_MAX_TOTAL_SIZE_MB, 1000) * 1024 * 1024;
const UPLOAD_API_PAGE_SIZE = 100; // API maximum
const UPLOAD_API_DEFAULT_EXPIRY = 604800; // 1 week (allowed: 0 = never, 3600, 86400, 604800, 2592000)

type MFile = Express.Multer.File;

let browser: puppeteer.Browser;
let page: puppeteer.Page;
let inInit = false;
let localProxyUrl: string;
let lastProxyUpdate = Date.now();
export let proxyIp: string;

// scheme should be socks5h for Node clients (remote DNS); proxy-chain accepts either.
function upstreamSocksUrl(scheme = 'socks5'): string {
  const user = encodeURIComponent(process.env.SOCKS5_USER ?? '');
  const pass = encodeURIComponent(process.env.SOCKS5_PASSWORD ?? '');
  const auth = user ? `${user}:${pass}@` : '';

  return `${scheme}://${auth}${process.env.SOCKS5_HOST}`;
}

// Chrome can't authenticate to a SOCKS5 proxy, so proxy-chain provides a local, no-auth
// HTTP proxy which forwards to the authenticated upstream SOCKS5 proxy.
export async function stopLocalProxy(): Promise<void> {
  if (localProxyUrl) {
    const url = localProxyUrl;

    localProxyUrl = undefined;
    await closeAnonymizedProxy(url, true);
  }
}

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

      if (newProxy)
        await stopLocalProxy();

      localProxyUrl ??= await anonymizeProxy(upstreamSocksUrl());

      const options: puppeteer.LaunchOptions = {
        args: [`--proxy-server=${localProxyUrl}`],
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

export async function getExternalUploadLink(req: express.Request, file: MFile, signal?: AbortSignal): Promise<string> {
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

  signal?.throwIfAborted();

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
    signal?.throwIfAborted();
    const chunk = fileBuffer.subarray(i, i + CHUNK_SIZE).toString('base64');
    // @ts-ignore
    await page.evaluate((chunk: string) => { (window as any).__fileChunks.push(chunk); }, chunk);
  }

  signal?.throwIfAborted();

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
        { timeout: 5000, signal });
    }
    catch {}

    if (signal?.aborted)
      break;

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

    if (!link && !error) {
      try {
        await delay(5000, undefined, { signal });
      }
      catch {
        break;
      }
    }
  } while (!link && !error && lackOfProgress < 8);

  if (!link && signal?.aborted) {
    // Reloading the page stops the in-browser upload.
    page.reload().catch(() => {});
    throw signal.reason;
  }

  if (!error && !link)
    error = 'Upload stalled for unknown reason';

  reportUploadProgress(req, 0);

  if (link)
    return link;

  initExternalUploader(true).catch();
  throw new Error('External uploader: ' + (error || 'failed to upload file'));
}

let uploadApi: AxiosInstance;

function getUploadApi(): AxiosInstance {
  if (!uploadApi) {
    if (process.env.SOCKS5_HOST) {
      // socks5h: DNS is resolved by the proxy, not locally
      const agent = new SocksProxyAgent(upstreamSocksUrl('socks5h'), { keepAlive: true });

      uploadApi = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false });
    }
    else
      uploadApi = axios.create();
  }

  return uploadApi;
}

function uploadApiHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.UPLOAD_API_KEY}` };
}

interface ApiFile {
  created_at: string;
  name: string;
  size: number;
  uuid: string;
}

async function getUploadApiFiles(signal?: AbortSignal): Promise<ApiFile[]> {
  const files: ApiFile[] = [];

  for (let pageNum = 1; ; ++pageNum) {
    const response = (await getUploadApi().get<{ files?: ApiFile[]; total: number }>(UPLOAD_API_FILES_URL, {
      headers: uploadApiHeaders(),
      signal,
      params: { folder: UPLOAD_API_FOLDER, page: pageNum, per_page: UPLOAD_API_PAGE_SIZE, sort: 'created_at', order: 'desc' }
    }))?.data;

    response?.files?.forEach(f => files.push(f));

    if (!response || response.files?.length === 0 || files.length >= response.total)
      break;
  }

  return files;
}

async function getUniqueUploadApiFileName(originalName: string, signal?: AbortSignal): Promise<string> {
  const existing = (await getUploadApiFiles(signal))?.map(f => f.name);
  const ext = extname(originalName).toLowerCase();
  let name: string;

  do {
    name = randomBytes(12).toString('hex').toUpperCase() + ext;
  } while (existing.includes(name));

  return name;
}

export async function getUploadApiUploadLink(req: express.Request, file: MFile, signal?: AbortSignal,
                                             expiry = UPLOAD_API_DEFAULT_EXPIRY): Promise<string> {
  if (!process.env.UPLOAD_API_KEY)
    throw new Error('Upload API: no API key configured');

  let link: string;
  let error: string;

  try {
    const form = new FormData();
    const fileName = await getUniqueUploadApiFileName(file.originalname, signal);

    form.append('file', await openAsBlob(file.path, { type: file.mimetype }), fileName);
    form.append('expiry', expiry.toString());
    form.append('folder', UPLOAD_API_FOLDER);

    const response = await getUploadApi().post(UPLOAD_API_FILES_URL, form, {
      headers: uploadApiHeaders(),
      signal,
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
  doApiUploaderFileMaintenance().catch();

  if (link)
    return link;

  throw new Error('Upload API: ' + (error || 'failed to upload file'));
}

async function deleteUploadApiFile(file: ApiFile): Promise<void> {
  await getUploadApi().delete(UPLOAD_API_FILES_URL + '/' + file.uuid, { headers: uploadApiHeaders() });
}

let doingMaintenance = false;

async function doApiUploaderFileMaintenance(): Promise<void> {
  if (doingMaintenance)
    return;

  doingMaintenance = true;

  const files = await getUploadApiFiles();
  const oldestAllowed = new Date(Date.now() - UPLOAD_API_MAX_AGE_SECS * 1000).toISOString().replace(/\.\d\d\dZ$/, 'Z');

  while (files.length > UPLOAD_API_MAX_FILES)
    await deleteUploadApiFile(files.pop());

  while (last(files)?.created_at < oldestAllowed)
    await deleteUploadApiFile(files.pop());

  let totalSize = files.reduce((acc, file) => acc + file.size, 0);

  while (totalSize > UPLOAD_API_MAX_TOTAL_SIZE) {
    const lastFile = files.pop();
    totalSize -= lastFile.size;
    await deleteUploadApiFile(lastFile);
  }

  doingMaintenance = false;
}
