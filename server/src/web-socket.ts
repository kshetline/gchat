import * as http from 'http';
import { AddressInfo, WebSocketServer } from 'ws';
import { toInt } from '@tubular/util';

const httpPort = toInt(process.env.PORT) || 3000;
export const wsPort = toInt(process.env.CHAT_WEB_SOCKET_PORT);

let wsServer: WebSocketServer;

export function startWebSocketServer(server: http.Server): void {
  if (wsPort) {
    let tries = 10;
    let retrying = false;

    function retry(err: any): void {
      retrying = true;

      if (retrying)
        return;

      if (--tries === 0)
        throw err;
      else {
        console.warn('Trying again to start websocket server...');
        setTimeout(startWebSocketServer, 500);
      }
    }

    function startWebSocketServer(): void {
      retrying = false;

      let port: number;

      try {
        if (server && (wsPort < 0 || wsPort === httpPort)) {
          wsServer = new WebSocketServer({ server });
          port = (server.address() as AddressInfo).port;
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
        retry(err);
      }

      if (port) {
        console.log(`WebSocket server listening on port ${port}`);
      }
    }

    startWebSocketServer();
  }
}

export function sendToAll(message: string, data?: any): void {
  if (wsServer)
    wsServer.clients.forEach(client => client.send(message + (data ? `\t${JSON.stringify(data)}` : '')));
}
