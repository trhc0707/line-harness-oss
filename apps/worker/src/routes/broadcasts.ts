import { Hono } from 'hono';
import {
  getBroadcasts,
  getBroadcastById,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
} from '@line-crm/db';
import type { Broadcast as DbBroadcast, BroadcastMessageType, BroadcastTargetType } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { processBroadcastSend } from '../services/broadcast.js';
import { processSegmentSend } from '../services/segment-send.js';
import type { SegmentCondition } from '../services/segment-query.js';
import type { Env } from '../index.js';

const broadcasts = new Hono<Env>();

function serializeBroadcast(row: DbBroadcast) {
  return {
    id: row.id,
    title: row.title,
    messageType: row.message_type,
    messageContent: row.message_content,
    targetType: row.target_type,
    targetTagId: row.target_tag_id,
    status: row.status,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    totalCount: row.total_count,
    successCount: row.success_count,
    createdAt: row.created_at,
  };
}

// GET /api/broadcasts - list all
broadcasts.get('/api/broadcasts', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let items: DbBroadcast[];
    if (lineAccountId) {
      const result = await c.env.DB
        .prepare(`SELECT * FROM broadcasts WHERE line_account_id = ? ORDER BY created_at DESC`)
        .bind(lineAccountId)
        .all<DbBroadcast>();
      items = result.results;
    } else {
      items = await getBroadcasts(c.env.DB);
    }
    return c.json({ success: true, data: items.map(serializeBroadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/broadcasts/:id - get single
broadcasts.get('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const broadcast = await getBroadcastById(c.env.DB, id);

    if (!broadcast) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) });
  } catch (err) {
    console.error('GET /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts - create
broadcasts.post('/api/broadcasts', async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      messageType: BroadcastMessageType;
      messageContent: string;
      targetType: BroadcastTargetType;
      targetTagId?: string | null;
      scheduledAt?: string | null;
      lineAccountId?: string | null;
      altText?: string | null;
    }>();

    if (!body.title || !body.messageType || !body.messageContent || !body.targetType) {
      return c.json(
        { success: false, error: 'title, messageType, messageContent, and targetType are required' },
        400,
      );
    }

    if (body.targetType === 'tag' && !body.targetTagId) {
      return c.json(
        { success: false, error: 'targetTagId is required when targetType is "tag"' },
        400,
      );
    }

    const broadcast = await createBroadcast(c.env.DB, {
      title: body.title,
      messageType: body.messageType,
      messageContent: body.messageContent,
      targetType: body.targetType,
      targetTagId: body.targetTagId ?? null,
      scheduledAt: body.scheduledAt ?? null,
    });

    // Save line_account_id and alt_text if provided
    const updates: string[] = [];
    const binds: unknown[] = [];
    if (body.lineAccountId) { updates.push('line_account_id = ?'); binds.push(body.lineAccountId); }
    if (body.altText) { updates.push('alt_text = ?'); binds.push(body.altText); }
    if (updates.length > 0) {
      binds.push(broadcast.id);
      await c.env.DB.prepare(`UPDATE broadcasts SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...binds).run();
    }

    return c.json({ success: true, data: serializeBroadcast(broadcast) }, 201);
  } catch (err) {
    console.error('POST /api/broadcasts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/broadcasts/:id - update draft
broadcasts.put('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status !== 'draft' && existing.status !== 'scheduled') {
      return c.json({ success: false, error: 'Only draft or scheduled broadcasts can be updated' }, 400);
    }

    const body = await c.req.json<{
      title?: string;
      messageType?: BroadcastMessageType;
      messageContent?: string;
      targetType?: BroadcastTargetType;
      targetTagId?: string | null;
      scheduledAt?: string | null;
    }>();

    // Keep status in sync with scheduledAt changes
    let statusUpdate: 'draft' | 'scheduled' | undefined;
    if (body.scheduledAt !== undefined) {
      statusUpdate = body.scheduledAt ? 'scheduled' : 'draft';
    }

    const updated = await updateBroadcast(c.env.DB, id, {
      title: body.title,
      message_type: body.messageType,
      message_content: body.messageContent,
      target_type: body.targetType,
      target_tag_id: body.targetTagId,
      scheduled_at: body.scheduledAt,
      ...(statusUpdate !== undefined ? { status: statusUpdate } : {}),
    });

    return c.json({ success: true, data: updated ? serializeBroadcast(updated) : null });
  } catch (err) {
    console.error('PUT /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/broadcasts/:id - delete
broadcasts.delete('/api/broadcasts/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteBroadcast(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/broadcasts/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send - send now
broadcasts.post('/api/broadcasts/:id/send', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'sent') {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processBroadcastSend(c.env.DB, lineClient, id, c.env.WORKER_URL);

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/broadcasts/:id/send-segment - send to a filtered segment
broadcasts.post('/api/broadcasts/:id/send-segment', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getBroadcastById(c.env.DB, id);

    if (!existing) {
      return c.json({ success: false, error: 'Broadcast not found' }, 404);
    }

    if (existing.status === 'sending' || existing.status === 'sent') {
      return c.json({ success: false, error: 'Broadcast is already sent or sending' }, 400);
    }

    const body = await c.req.json<{ conditions: SegmentCondition }>();

    if (!body.conditions || !body.conditions.operator || !Array.isArray(body.conditions.rules)) {
      return c.json(
        { success: false, error: 'conditions with operator and rules array is required' },
        400,
      );
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    await processSegmentSend(c.env.DB, lineClient, id, body.conditions);

    const result = await getBroadcastById(c.env.DB, id);
    return c.json({ success: true, data: result ? serializeBroadcast(result) : null });
  } catch (err) {
    console.error('POST /api/broadcasts/:id/send-segment error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/multicast - send message to specific friend IDs
broadcasts.post('/api/multicast', async (c) => {
  try {
    const body = await c.req.json<{
      friendIds: string[];
      messageType: string;
      messageContent: string;
      altText?: string | null;
    }>();

    if (!Array.isArray(body.friendIds) || body.friendIds.length === 0) {
      return c.json({ success: false, error: 'friendIds array is required' }, 400);
    }
    if (!body.messageType || !body.messageContent) {
      return c.json({ success: false, error: 'messageType and messageContent are required' }, 400);
    }

    // Fetch friends and get their LINE user IDs
    const placeholders = body.friendIds.map(() => '?').join(',');
    const result = await c.env.DB
      .prepare(`SELECT id, line_user_id, is_following FROM friends WHERE id IN (${placeholders})`)
      .bind(...body.friendIds)
      .all<{ id: string; line_user_id: string; is_following: number }>();

    const followingFriends = result.results.filter((f) => f.is_following);
    if (followingFriends.length === 0) {
      return c.json({ success: false, error: 'No following friends found in the selection' }, 400);
    }

    const lineUserIds = followingFriends.map((f) => f.line_user_id);

    // Build message
    const { extractFlexAltText } = await import('../utils/flex-alt-text.js');
    let message: import('@line-crm/line-sdk').Message;
    if (body.messageType === 'text') {
      message = { type: 'text', text: body.messageContent };
    } else if (body.messageType === 'flex') {
      const contents = JSON.parse(body.messageContent);
      message = { type: 'flex', altText: body.altText || extractFlexAltText(contents), contents };
    } else if (body.messageType === 'image') {
      const parsed = JSON.parse(body.messageContent);
      message = { type: 'image', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl };
    } else if (body.messageType === 'video') {
      const parsed = JSON.parse(body.messageContent);
      message = { type: 'video', originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl } as import('@line-crm/line-sdk').Message;
    } else {
      message = { type: 'text', text: body.messageContent };
    }

    // Send via multicast in 500-batch chunks
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const { calculateStaggerDelay, sleep, addMessageVariation } = await import('../services/stealth.js');
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(lineUserIds.length / BATCH_SIZE);
    let successCount = 0;

    const { jstNow } = await import('@line-crm/db');
    const now = jstNow();

    for (let i = 0; i < lineUserIds.length; i += BATCH_SIZE) {
      const batchIndex = Math.floor(i / BATCH_SIZE);
      const batch = lineUserIds.slice(i, i + BATCH_SIZE);
      const batchFriends = followingFriends.slice(i, i + BATCH_SIZE);

      if (batchIndex > 0) {
        const delay = calculateStaggerDelay(lineUserIds.length, batchIndex);
        await sleep(delay);
      }

      let batchMessage = message;
      if (message.type === 'text' && totalBatches > 1) {
        batchMessage = { ...message, text: addMessageVariation(message.text, batchIndex) };
      }

      try {
        await lineClient.multicast(batch, [batchMessage]);
        successCount += batch.length;

        // Log messages
        for (const friend of batchFriends) {
          const logId = crypto.randomUUID();
          await c.env.DB
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
            )
            .bind(logId, friend.id, body.messageType, body.messageContent, now)
            .run();
        }
      } catch (err) {
        console.error(`Multicast batch ${batchIndex} failed:`, err);
      }
    }

    return c.json({
      success: true,
      data: {
        totalCount: followingFriends.length,
        successCount,
        skippedCount: body.friendIds.length - followingFriends.length,
      },
    });
  } catch (err) {
    console.error('POST /api/multicast error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { broadcasts };
