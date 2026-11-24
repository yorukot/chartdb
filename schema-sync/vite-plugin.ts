import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { WebSocketServer } from 'ws';

// Keeps one diagram in step between a JSON file and every open ChartDB tab,
// over a WebSocket at /schema-sync. Write the file and the tabs load it; edit
// in a tab and the file is rewritten. It runs in both `vite` and
// `vite preview`, so the fast production build syncs too.
// src/pages/editor-page/schema-sync.tsx is the tab's side.
export function schemaSync(): Plugin {
    const file = path.resolve(
        process.env.SCHEMA_DIAGRAM ?? 'schema-sync/diagram.json'
    );

    const attach = (httpServer: Server | null, log: (msg: string) => void) => {
        if (!httpServer) return;
        const read = () =>
            fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        let last = read();

        const wss = new WebSocketServer({ noServer: true });
        httpServer.on('upgrade', (req, socket, head) => {
            if (req.url !== '/schema-sync') return; // Vite's own HMR socket, say
            wss.handleUpgrade(req, socket, head, (ws) =>
                wss.emit('connection', ws, req)
            );
        });
        const broadcast = (json: string) => {
            wss.clients.forEach((client) => {
                if (client.readyState === client.OPEN) client.send(json);
            });
        };

        wss.on('connection', (ws) => {
            if (last) ws.send(last);
            ws.on('message', (data) => {
                const json = data.toString();
                if (json === last) return;
                last = json;
                fs.writeFileSync(file, last);
                broadcast(last);
            });
        });

        fs.mkdirSync(path.dirname(file), { recursive: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        fs.watch(path.dirname(file), (_event, name) => {
            if (name !== path.basename(file)) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                const json = read();
                if (!json || json === last) return;
                try {
                    JSON.parse(json);
                } catch {
                    return; // Still being written.
                }
                last = json;
                broadcast(json);
            }, 100);
        });

        log(`  schema-sync: ${file}`);
    };

    return {
        name: 'schema-sync',
        config: () => ({ server: { watch: { ignored: [file] } } }),
        configureServer(server) {
            attach(
                server.httpServer as Server | null,
                server.config.logger.info
            );
        },
        configurePreviewServer(server) {
            attach(server.httpServer as Server, server.config.logger.info);
        },
    };
}
