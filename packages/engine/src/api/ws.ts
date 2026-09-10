import type { UpgradeWebSocket } from 'hono/ws';
import { API_PREFIX, ORCA_VERSION, type ApprovalRecord, type StoredRunEvent, type TranscriptRow, type WsClientMessage, type WsServerMessage } from '@orca/shared';
import type { Engine } from '../engine.js';

/**
 * One WebSocket per UI tab. Clients subscribe to runs; approvals are broadcast to everyone.
 * `node.progress` events are coalesced per node to at most ~10/s.
 */
export function registerWebSocket(engine: Engine, upgradeWebSocket: UpgradeWebSocket): void {
  const { app, services } = engine;

  app.get(
    `${API_PREFIX}/ws`,
    upgradeWebSocket(() => {
      const subs = new Set<string>();
      let send: ((msg: WsServerMessage) => void) | undefined;
      const progressBuffer = new Map<string, { event: StoredRunEvent; text: string }>();
      let flushTimer: NodeJS.Timeout | undefined;

      const flush = () => {
        flushTimer = undefined;
        for (const [, buf] of progressBuffer) {
          const e = buf.event.event;
          if (e.type === 'node.progress') send?.({ channel: 'run', runId: buf.event.runId, event: { ...buf.event, event: { ...e, text: buf.text } } });
        }
        progressBuffer.clear();
      };

      const onEvent = (ev: StoredRunEvent) => {
        if (!subs.has(ev.runId)) return;
        if (ev.event.type === 'node.progress' && (ev.event.kind === 'stdout' || ev.event.kind === 'stderr')) {
          const key = `${ev.runId}:${ev.event.nodeId}@${ev.event.scope}:${ev.event.kind}`;
          const buf = progressBuffer.get(key);
          if (buf) buf.text += ev.event.text;
          else progressBuffer.set(key, { event: ev, text: ev.event.text });
          if (!flushTimer) flushTimer = setTimeout(flush, 100);
          return;
        }
        send?.({ channel: 'run', runId: ev.runId, event: ev });
      };
      const onTranscript = (row: TranscriptRow) => {
        if (subs.has(row.runId)) send?.({ channel: 'transcript', runId: row.runId, row });
      };
      const onApproval = (approval: ApprovalRecord) => send?.({ channel: 'approval', approval });

      return {
        onOpen(_evt, ws) {
          send = (msg) => {
            try {
              ws.send(JSON.stringify(msg));
            } catch {
              /* socket closed */
            }
          };
          services.store.on('event', onEvent);
          services.store.on('transcript', onTranscript);
          services.store.on('approval', onApproval);
          send({ channel: 'hello', engineVersion: ORCA_VERSION });
        },
        onMessage(evt) {
          let msg: WsClientMessage | undefined;
          try {
            msg = JSON.parse(String(evt.data)) as WsClientMessage;
          } catch {
            return;
          }
          if ('subscribe' in msg) subs.add(msg.subscribe.runId);
          if ('unsubscribe' in msg) subs.delete(msg.unsubscribe.runId);
        },
        onClose() {
          services.store.off('event', onEvent);
          services.store.off('transcript', onTranscript);
          services.store.off('approval', onApproval);
          if (flushTimer) clearTimeout(flushTimer);
          send = undefined;
        },
      };
    }),
  );
}
