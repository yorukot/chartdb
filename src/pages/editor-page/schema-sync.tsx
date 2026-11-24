import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChartDB } from '@/hooks/use-chartdb';
import { useDialog } from '@/hooks/use-dialog';
import { diagramSchema } from '@/lib/domain/diagram';

// The tab's side of schema-sync/vite-plugin.ts: loads the diagram that the
// file holds, and sends this tab's edits to it back. Other diagrams don't sync.
export const SchemaSync: React.FC = () => {
    const { currentDiagram, updateDiagramData } = useChartDB();
    const { closeCreateDiagramDialog, closeOpenDiagramDialog } = useDialog();
    const navigate = useNavigate();

    const socket = useRef<WebSocket>();
    const syncedId = useRef<string>();
    const lastJSON = useRef<string>();
    const latest = useRef({
        updateDiagramData,
        closeCreateDiagramDialog,
        closeOpenDiagramDialog,
        navigate,
    });
    latest.current = {
        updateDiagramData,
        closeCreateDiagramDialog,
        closeOpenDiagramDialog,
        navigate,
    };

    useEffect(() => {
        const onDiagram = async (json: string) => {
            if (json === lastJSON.current) return;
            const raw = JSON.parse(json);
            const parsed = diagramSchema.safeParse({
                ...raw,
                createdAt: new Date(raw.createdAt),
                updatedAt: new Date(raw.updatedAt),
            });
            if (!parsed.success) {
                console.error('schema-sync: not a diagram', parsed.error);
                return;
            }
            const diagram = parsed.data;
            syncedId.current = diagram.id;
            lastJSON.current = json;

            const l = latest.current;
            await l.updateDiagramData(diagram, { forceUpdateStorage: true });
            l.closeCreateDiagramDialog();
            l.closeOpenDiagramDialog();
            if (window.location.pathname !== `/diagrams/${diagram.id}`) {
                l.navigate(`/diagrams/${diagram.id}`);
            }
        };

        // Reconnects when the server restarts.
        let closed = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const connect = () => {
            const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(
                `${scheme}://${window.location.host}/schema-sync`
            );
            ws.onmessage = (event) => onDiagram(event.data);
            ws.onclose = () => {
                if (!closed) retry = setTimeout(connect, 2000);
            };
            socket.current = ws;
        };
        connect();
        return () => {
            closed = true;
            clearTimeout(retry);
            socket.current?.close();
        };
    }, []);

    useEffect(() => {
        if (!currentDiagram.id || currentDiagram.id !== syncedId.current)
            return;

        const timer = setTimeout(() => {
            const ws = socket.current;
            if (ws?.readyState !== WebSocket.OPEN) return;
            const json = JSON.stringify(currentDiagram, null, 2) + '\n';
            if (json === lastJSON.current) return;
            lastJSON.current = json;
            ws.send(json);
        }, 300);
        return () => clearTimeout(timer);
    }, [currentDiagram]);

    return null;
};
