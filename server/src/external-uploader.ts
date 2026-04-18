import * as puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import fs from 'fs/promises';
import { sleep, toNumber } from '@tubular/util';
import express from 'express';
import { reportUploadProgress } from './app.js';
import { restartLocalSocksProxy, startLocalSocksProxy } from './socks-proxy.js';
import { extractIp } from './chat-util.js';

const PROXY_UPDATE_INTERVAL = 7200000; // 2 hours

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
      if (!inInit) {
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
      await page?.close().catch(() => {});
      page = undefined;
      await browser?.close().catch(() => {});
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

  if (!uploaderReady)
    throw new Error('External uploader not available');

  const fileBuffer = await readFile(file.path);
  const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

  await page.reload();
  (await page.waitForSelector('button.timeSelector:nth-child(5)', { timeout: 10000 }))?.click();

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
      }
      catch {}
    }

    if (!link && !error)
      await sleep(5000);
  } while (!link && !error && lackOfProgress < 8);

  if (!error && !link)
    error = 'Upload stalled for unknown reason';

  reportUploadProgress(req, 0);

  try {
    await fs.unlink(file.path);
  }
  catch {}

  if (link)
    return link;

  initExternalUploader(true).catch().finally();
  throw new Error('External uploader: ' + (error || 'failed to upload file'));
}
