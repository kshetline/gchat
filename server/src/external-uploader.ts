import * as puppeteer from 'puppeteer';
import * as net from 'net';
import { SocksClient } from 'socks';
import { readFile } from 'node:fs/promises';
import fs from 'fs/promises';

type MFile = Express.Multer.File;

let browser: puppeteer.Browser;
let page: puppeteer.Page;
let inInit = false;

export async function initExternalUploader(force = false): Promise<void> {
  if (inInit) return new Promise<void>(resolve => {
    const interval = setInterval(() => {
      if (!inInit) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });

  if (browser && !force) return;

  try {
    inInit = true;

    if (page) await page.close();
    if (browser) await browser.close();

    const port = await startLocalSocksProxy();

    const options: puppeteer.LaunchOptions = {
      args: [`--proxy-server=socks5://127.0.0.1:${port}`],
    };

    if (process.env.CHROME_PATH) {
      options.executablePath = process.env.CHROME_PATH;
      options.args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
    }

    browser = browser || (await puppeteer.launch(options));
    page = page || (await browser.newPage());
    await page.goto(process.env.EXTERNAL_UPLOADER);
    console.info('External uploader initialized');
  }
  catch (error) {
    page?.close();
    page = undefined;
    browser?.close();
    browser = undefined;
    console.error('Failed to initialize external uploader:', error);
  }
  finally {
    inInit = false;
  }
}

let localProxyServer: net.Server;
let localProxyPort: number;

async function startLocalSocksProxy(): Promise<number> {
  if (localProxyServer) return localProxyPort;

  const [host, portStr] = process.env.SOCKS5_HOST.split(':');
  const remotePort = parseInt(portStr);

  return new Promise((resolve, reject) => {
    const server = net.createServer(clientSocket => {
      // Read the SOCKS5 greeting from the browser
      clientSocket.once('data', _greeting => {
        // Respond: version 5, no auth required (for localhost)
        clientSocket.write(Buffer.from([0x05, 0x00]));

        clientSocket.once('data', async (request: Buffer) => {
          const atyp = request[3];

          let targetHost: string;
          let targetPort: number;

          if (atyp === 0x01) { // IPv4
            targetHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
            targetPort = request.readUInt16BE(8);
          }
          else if (atyp === 0x03) { // Domain
            const len = request[4];
            targetHost = request.subarray(5, 5 + len).toString();
            targetPort = request.readUInt16BE(5 + len);
          }
          else {
            clientSocket.destroy();
            return;
          }

          try {
            const { socket } = await SocksClient.createConnection({
              proxy: { host, port: remotePort, type: 5,
                userId: process.env.SOCKS5_USER, password: process.env.SOCKS5_PASSWORD },
              command: 'connect',
              destination: { host: targetHost, port: targetPort },
            });

            // Tell Chrome the connection succeeded
            const reply = Buffer.alloc(10);
            reply[0] = 0x05; reply[1] = 0x00; reply[2] = 0x00; reply[3] = 0x01;
            clientSocket.write(reply);

            socket.pipe(clientSocket);
            clientSocket.pipe(socket);
            socket.on('error', () => clientSocket.destroy());
            clientSocket.on('error', () => socket.destroy());
          }
          catch {
            const reply = Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            clientSocket.write(reply);
            clientSocket.destroy();
          }
        });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      localProxyServer = server;
      localProxyPort = (server.address() as net.AddressInfo).port;
      resolve(localProxyPort);
    });

    server.on('error', reject);
  });
}

export async function getExternalUploadLink(file: MFile): Promise<string> {
  await initExternalUploader();
  const fileData = (await readFile(file.path)).toString('base64');

  await page.reload();
  (await page.waitForSelector('[id="72h"]', { timeout: 10000 }))?.click();
  await page.evaluate(
    ({ fileData, filename, mimetype, selector }) => {
      // Create a JS File object in the browser
      const byteCharacters = atob(fileData);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const file = new File([byteArray], filename, { type: mimetype });

      // Create a mock DataTransfer object
      // @ts-ignore
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      // @ts-ignore
      const input = document.querySelector(selector);
      // @ts-ignore
      input.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true }));
    },
    {
      fileData,
      filename: file.originalname,
      mimetype: file.mimetype,
      selector: '#dropzoneUpload'
    }
  );

  await page.waitForSelector('div.dz-preview.dz-complete :is(.responseText, .dz-error-message)', { timeout: 15000 });

  let link: string;
  let error: string;

  try {
    link = await page.$eval('div.dz-preview.dz-success .responseText', el => el.innerText);
  }
  catch {}

  if (!link) {
    try {
      error = await page.$eval('div.dz-preview.dz-complete .dz-error-message', el => el.innerText);
    }
    catch {}
  }

  try {
    await fs.unlink(file.path);
  }
  catch {}

  if (link)
    return link;

  throw new Error('External uploader: ' + (error || 'failed to upload file'));
}
