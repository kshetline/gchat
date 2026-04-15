import net from 'net';
import { SocksClient } from 'socks';

let localProxyServer: net.Server;
let localProxyPort: number;

export async function startLocalSocksProxy(): Promise<number> {
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
