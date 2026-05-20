import * as http from 'http';
import { AddressInfo, WebSocketServer } from 'ws';
import { toInt } from '@tubular/util';

const httpPort = toInt(process.env.PORT) || 3000;
export const wsPort = toInt(process.env.CHAT_WEB_SOCKET_PORT);
const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

let wsServer: WebSocketServer;

export function startWebSocketServer(server?: http.Server): void {
  if (wsPort < 0) {
    console.info('Not starting websocket server:', wsPort);
    return;
  }

  console.info('Starting websocket server...');

  let tries = 10;
  let retrying = false;

  function retry(err: any): void {
    if (retrying)
      return;

    retrying = true;

    if (--tries === 0)
      throw err;
    else {
      console.warn('Trying again to start websocket server...');
      setTimeout(startWSS, 500);
    }
  }

  function startWSS(): void {
    retrying = false;

    let port: number;

    try {
      if (server && (wsPort === 0 || wsPort === httpPort)) {
        wsServer = new WebSocketServer({ server });
        port = (server.address() as AddressInfo).port || httpPort;
      }
      else {
        server = http.createServer();
        server.once('error', err => retry(err));
        wsServer = new WebSocketServer({ server });
        wsServer.once('error', err => retry(err));
        server.listen(wsPort);
        port = wsPort;
      }
    }
    catch (err) {
      console.error('Failed to start websocket server:', (err as any).message || String(err));
      wsServer = undefined;
      retrying = false;
      retry(err);
      return;
    }

    wsServer?.on('connection', (ws, req) => {
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
        req.socket?.remoteAddress || (req as any).connection?.remoteAddress;

      (ws as any).remoteAddress = loopbacks.has(ip) ? '::1' : ip;
    });

    if (wsServer)
      console.log(`WebSocket server listening on port ${port}`);
    else
      console.warn('WebSocket server not created');
  }

  startWSS();
}

export function sendToAll(message: string, data?: any): void {
  if (wsServer)
    wsServer.clients.forEach(client => client.send(message + (data ? `\t${JSON.stringify(data)}` : '')));
}

export function sendToIp(ip: string, message: string, data?: any): void {
  if (wsServer)
    for (const client of wsServer.clients)
      if ((client as any).remoteAddress === ip)
        client.send(message + (data ? `\t${JSON.stringify(data)}` : ''));
}
