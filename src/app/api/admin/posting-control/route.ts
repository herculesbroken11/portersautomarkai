/**
 * Admin API Route: Posting Control (Kill Switch)
 * Phase 1: Global Kill Switch Toggle
 *
 * Uses Firebase Admin SDK so the API works without browser auth (server-side).
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminFirestore, isAdminSDKAvailable } from '@/firebase/admin';

/**
 * GET - Get current posting control status
 */
export async function GET(request: NextRequest) {
  try {
    if (!isAdminSDKAvailable() || !adminFirestore) {
      return NextResponse.json(
        { error: 'Firebase Admin SDK not configured', message: 'Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_ADMIN_SERVICE_ACCOUNT' },
        { status: 503 }
      );
    }

    const docSnap = await adminFirestore.collection('system_settings').doc('posting').get();

    if (!docSnap.exists) {
      return NextResponse.json({
        posting_paused: false,
        message: 'Posting is currently enabled (default state)',
      });
    }

    const data = docSnap.data();
    return NextResponse.json({
      posting_paused: data?.posting_paused === true,
      paused_at: data?.paused_at,
      paused_by: data?.paused_by,
      paused_reason: data?.paused_reason,
      last_updated: data?.last_updated,
    });
  } catch (error: any) {
    console.error('[POSTING_CONTROL_API] Error getting status:', error);
    return NextResponse.json(
      { error: 'Failed to get posting control status', message: error.message },
      { status: 500 }
    );
  }
}

/**
 * POST - Update posting control status (pause/resume)
 * Body: { posting_paused: boolean, paused_reason?: string, actor?: string }
 * In production, send Authorization: Bearer <ADMIN_SECRET> or x-admin-secret: <ADMIN_SECRET> if ADMIN_SECRET is set in env.
 */
export async function POST(request: NextRequest) {
  try {
    const adminSecret = process.env.ADMIN_SECRET;
    if (adminSecret) {
      const authHeader = request.headers.get('authorization') || '';
      const bearerToken = authHeader.split('Bearer ').at(1)?.trim();
      const headerSecret = request.headers.get('x-admin-secret')?.trim();
      const provided = bearerToken || headerSecret;
      if (provided !== adminSecret) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Missing or invalid admin authorization. Send Authorization: Bearer <ADMIN_SECRET> or x-admin-secret: <ADMIN_SECRET>.' },
          { status: 403 }
        );
      }
    }

    if (!isAdminSDKAvailable() || !adminFirestore) {
      return NextResponse.json(
        { error: 'Firebase Admin SDK not configured', message: 'Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_ADMIN_SERVICE_ACCOUNT' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { posting_paused, paused_reason, actor } = body;

    if (typeof posting_paused !== 'boolean') {
      return NextResponse.json(
        { error: 'Invalid request. posting_paused must be a boolean.' },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      posting_paused,
      last_updated: now,
    };

    if (posting_paused) {
      updateData.paused_at = now;
      updateData.paused_by = actor || 'system';
      if (paused_reason) updateData.paused_reason = paused_reason;
    } else {
      updateData.resumed_at = now;
      updateData.resumed_by = actor || 'system';
    }

    await adminFirestore.collection('system_settings').doc('posting').set(updateData, { merge: true });

    return NextResponse.json({
      success: true,
      message: posting_paused
        ? 'Posting has been paused globally. All publish attempts will be blocked.'
        : 'Posting has been resumed. Publish attempts will be allowed.',
      posting_paused,
      last_updated: now,
    });
  } catch (error: any) {
    console.error('[POSTING_CONTROL_API] Error updating status:', error);
    return NextResponse.json(
      { error: 'Failed to update posting control status', message: error.message },
      { status: 500 }
    );
  }
}
