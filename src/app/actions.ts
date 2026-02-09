
'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import path from 'node:path';
import { generateReelFromText } from '@/ai/heygen';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage, galleryFirestore } from '@/firebase/config'; 
import axios from 'axios';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { isPostingPaused, POSTING_PAUSED_ERROR, isPlatformEnabled, PLATFORM_DISABLED_ERROR } from '@/lib/posting-control';
import { logBlockedPublish, logPublishAttempt } from '@/lib/audit-log';
import { canPublish, mapLegacyStatus, NOT_APPROVED_ERROR } from '@/lib/post-status';
import { checkRateCaps, autoPausePlatformIfNeeded, RATE_CAP_EXCEEDED_ERROR, COOLDOWN_ACTIVE_ERROR } from '@/lib/posting-caps';
import { recordPublishError, checkAuthFailures } from '@/lib/error-monitoring';
import {
  generateIdempotencyKey,
  checkDuplicateAttempt,
  recordPublishAttempt,
  acquirePublishLock,
  releasePublishLock,
  checkAlreadyPosted,
  DUPLICATE_BLOCKED_ERROR,
} from '@/lib/duplicate-protection';
import { getGoogleApiCredentials, getRefreshedAccessToken } from '@/lib/google-drive-auth';
import { adminFirestore, isAdminSDKAvailable } from '@/firebase/admin';

// Social API Logic
const INSTAGRAM_GRAPH_API_URL = 'https://graph.instagram.com/v20.0';

interface PostResponse {
    success: boolean;
    error?: string;
    postId?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function postToInstagram(args: {
    imageUrl?: string;
    videoUrl?: string;
    mediaType: 'IMAGE' | 'REELS';
    caption: string;
}): Promise<PostResponse> {
    const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
    const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

    if (!INSTAGRAM_ACCESS_TOKEN || !INSTAGRAM_ACCOUNT_ID) {
        const errorMsg = "Instagram Access Token or Account ID is not configured in .env file.";
        console.error(errorMsg);
        return { success: false, error: errorMsg };
    }

    try {
        console.log(`Step 1: Creating media container for ${args.mediaType}...`);
        const createContainerUrl = `${INSTAGRAM_GRAPH_API_URL}/${INSTAGRAM_ACCOUNT_ID}/media`;
        
        const payload: { [key: string]: any } = { caption: args.caption };

        if (args.mediaType === 'IMAGE' && args.imageUrl) {
            payload.image_url = args.imageUrl;
        } else if (args.mediaType === 'REELS' && args.videoUrl) {
            payload.video_url = args.videoUrl;
            payload.media_type = 'REELS';
        } else {
            throw new Error('Invalid arguments: An imageUrl is required for IMAGE posts, and a videoUrl is required for REELS.');
        }

        const containerResponse = await axios.post(createContainerUrl, payload, {
            headers: { 'Authorization': `Bearer ${INSTAGRAM_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });

        const creationId = containerResponse.data?.id;
        if (!creationId) {
            throw new Error('Failed to create media container. No creation_id received.');
        }
        console.log(`Successfully created container with ID: ${creationId}`);
        
        // Instagram needs time to process the media, especially videos.
        // We poll the status of the container until it's 'FINISHED'.
        let statusCheckAttempts = 0;
        const maxStatusChecks = 20; // Poll for up to 100 seconds
        while(statusCheckAttempts < maxStatusChecks) {
            console.log(`Polling container status... Attempt ${statusCheckAttempts + 1}`);
            await sleep(5000); // Wait 5 seconds between checks
            const statusUrl = `${INSTAGRAM_GRAPH_API_URL}/${creationId}?fields=status_code&access_token=${INSTAGRAM_ACCESS_TOKEN}`;
            const statusResponse = await axios.get(statusUrl);
            const statusCode = statusResponse.data.status_code;
            console.log(`Container status: ${statusCode}`);
            
            if (statusCode === 'FINISHED') {
                // Once finished, we can publish it.
                console.log("Step 2: Publishing media container...");
                const publishUrl = `${INSTAGRAM_GRAPH_API_URL}/${INSTAGRAM_ACCOUNT_ID}/media_publish`;
                const publishResponse = await axios.post(publishUrl, { 
                    creation_id: creationId,
                    access_token: INSTAGRAM_ACCESS_TOKEN
                });
                const postId = publishResponse.data?.id;
                 if (!postId) {
                    throw new Error('Container finished but publishing failed to return a post ID.');
                }
                console.log(`--- SUCCESSFULLY POSTED TO INSTAGRAM --- Post ID: ${postId}`);
                return { success: true, postId };
            }
            
            if (statusCode === 'ERROR') {
                console.error("Container processing failed.", statusResponse.data);
                throw new Error('Media container processing failed on Instagram\'s side.');
            }
            statusCheckAttempts++;
        }
        
        throw new Error('Failed to publish container: Timed out waiting for processing to finish.');

    } catch (error: any) {
        let errorMessage = 'An unknown error occurred during the Instagram post process.';
        if (axios.isAxiosError(error) && error.response) {
            console.error('Instagram API Error Response:', JSON.stringify(error.response.data, null, 2));
            errorMessage = error.response.data?.error?.message || 'An error occurred with the Instagram API.';
        } else {
            console.error('Error posting to Instagram:', error);
            errorMessage = error.message;
        }
        return { success: false, error: errorMessage };
    }
}

async function postToFacebook(args: { imageUrl: string, caption: string }): Promise<PostResponse> {
    const FACEBOOK_PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!FACEBOOK_PAGE_ACCESS_TOKEN || FACEBOOK_PAGE_ACCESS_TOKEN === 'YOUR_FB_PAGE_ACCESS_TOKEN') {
        const errorMsg = "Facebook Page Access Token is not configured.";
        console.error(errorMsg);
        return { success: false, error: errorMsg };
    }
    await sleep(1500);
    const simulatedPostId = `10158954894343513_${Date.now()}`;
    console.log(`Successfully simulated Facebook post with ID: ${simulatedPostId}`);
    return { success: true, postId: simulatedPostId };
}


// Server Action for Posting
export async function postNowAction(post: any): Promise<PostResponse> {
    let lockResult: { acquired: boolean; lockId?: string } | null = null;
    let idempotencyKey: string | null = null;
    let lockReleased = false;

    try {
        // Phase 1: Global Kill Switch Check
        if (await isPostingPaused()) {
            const errorMsg = POSTING_PAUSED_ERROR;
            console.error(`[POSTING_BLOCKED] Post ${post.id || 'unknown'} blocked: ${errorMsg}`);
            
            // Log blocked attempt
            await logBlockedPublish({
                actor: 'postNowAction',
                platform: post.platform || 'unknown',
                content_id: post.id,
                reason: errorMsg,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Per-Platform Toggle Check
        const platform = post.platform || 'unknown';
        if (!(await isPlatformEnabled(platform))) {
            const errorMsg = PLATFORM_DISABLED_ERROR;
            console.error(`[POSTING_BLOCKED] Post ${post.id || 'unknown'} blocked: Platform ${platform} is disabled`);
            
            await logBlockedPublish({
                actor: 'postNowAction',
                platform,
                content_id: post.id,
                reason: `${errorMsg}: Platform ${platform} is disabled`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Rate Caps and Throttling Check
        const rateCapCheck = await checkRateCaps(platform);
        if (!rateCapCheck.allowed) {
            const errorMsg = rateCapCheck.reason?.includes('Cooldown') ? COOLDOWN_ACTIVE_ERROR : RATE_CAP_EXCEEDED_ERROR;
            console.error(`[POSTING_BLOCKED] Post ${post.id || 'unknown'} blocked: ${rateCapCheck.reason}`);
            
            // Auto-pause platform if cap exceeded
            if (errorMsg === RATE_CAP_EXCEEDED_ERROR) {
                await autoPausePlatformIfNeeded(platform, rateCapCheck.reason || 'Rate cap exceeded');
            }
            
            await logBlockedPublish({
                actor: 'postNowAction',
                platform,
                content_id: post.id,
                reason: `${errorMsg}: ${rateCapCheck.reason}`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Backend-Enforced Approval Check
        const postStatus = mapLegacyStatus(post.status || 'DRAFT');
        if (!canPublish(postStatus)) {
            const errorMsg = NOT_APPROVED_ERROR;
            console.error(`[POSTING_BLOCKED] Post ${post.id || 'unknown'} blocked: Status ${postStatus} does not allow publishing`);
            
            // Log blocked attempt
            await logBlockedPublish({
                actor: 'postNowAction',
                platform: post.platform || 'unknown',
                content_id: post.id,
                reason: `${errorMsg}: Status is ${postStatus}, must be SCHEDULED or APPROVED`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Duplicate Protection - Check if already posted
        const alreadyPosted = await checkAlreadyPosted(post.id);
        if (alreadyPosted.alreadyPosted) {
            const errorMsg = DUPLICATE_BLOCKED_ERROR;
            console.error(`[POSTING_BLOCKED] Post ${post.id} already posted with platform_post_id: ${alreadyPosted.platformPostId}`);
            
            await logBlockedPublish({
                actor: 'postNowAction',
                platform: post.platform || 'unknown',
                content_id: post.id,
                reason: `${errorMsg}: Post already has platform_post_id: ${alreadyPosted.platformPostId}`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Duplicate Protection - Generate idempotency key
        const mediaSignature = post.videoUrl || post.stitchedImageUrl || post.imageUrls?.after || '';
        idempotencyKey = generateIdempotencyKey({
            content_id: post.id,
            platform: post.platform || 'unknown',
            scheduled_at_utc: post.scheduledAt || post.scheduled_at,
            media_signature: mediaSignature.substring(0, 100), // Use first 100 chars as signature
        });

        // Check for duplicate attempt
        const duplicateCheck = await checkDuplicateAttempt(idempotencyKey);
        if (duplicateCheck.isDuplicate) {
            const errorMsg = DUPLICATE_BLOCKED_ERROR;
            console.error(`[POSTING_BLOCKED] Duplicate attempt detected for key: ${idempotencyKey}`);
            
            await logBlockedPublish({
                actor: 'postNowAction',
                platform: post.platform || 'unknown',
                content_id: post.id,
                reason: `${errorMsg}: Duplicate idempotency key ${idempotencyKey}`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Phase 1: Duplicate Protection - Acquire lock
        lockResult = await acquirePublishLock(post.id, post.platform || 'unknown');
        if (!lockResult.acquired) {
            const errorMsg = DUPLICATE_BLOCKED_ERROR;
            console.error(`[POSTING_BLOCKED] Could not acquire lock for post ${post.id}`);
            
            await logBlockedPublish({
                actor: 'postNowAction',
                platform: post.platform || 'unknown',
                content_id: post.id,
                reason: `${errorMsg}: Lock already held by another process`,
            });
            
            return { success: false, error: errorMsg };
        }

        // Record attempt
        await recordPublishAttempt({
            idempotencyKey,
            content_id: post.id,
            platform: post.platform || 'unknown',
            status: 'attempting',
            actor: 'postNowAction',
        });

        let result;
        let lockReleased = false;
        const isVideoPost = !!post.videoUrl;
        const imageUrl = post.stitchedImageUrl || post.imageUrls?.after;
        const caption = `${post.text} ${post.hashtags ? post.hashtags.join(' ') : ''}`;

        if (post.platform.toLowerCase() === 'instagram') {
            result = await postToInstagram({
                imageUrl: isVideoPost ? undefined : imageUrl,
                videoUrl: isVideoPost ? post.videoUrl : undefined,
                mediaType: isVideoPost ? 'REELS' : 'IMAGE',
                caption: caption
            });
        } else if (post.platform.toLowerCase() === 'facebook') {
             if (!imageUrl && !isVideoPost) return { success: false, error: 'Cannot post to Facebook without an image or video.' };
             // Facebook API for videos is different, for now we only support images
             if (isVideoPost) return { success: false, error: 'Posting videos to Facebook is not yet supported.' };

            result = await postToFacebook({
                imageUrl: imageUrl,
                caption: caption
            });
        } else {
             return { success: false, error: `Posting to ${post.platform} is not yet supported.` };
        }

        // Release lock
        if (lockResult.lockId) {
            await releasePublishLock(lockResult.lockId);
            lockReleased = true;
        }

        // Update attempt record
        await recordPublishAttempt({
            idempotencyKey,
            content_id: post.id,
            platform: post.platform || 'unknown',
            status: result.success ? 'success' : 'failed',
            platform_post_id: result.postId,
            error: result.error,
            actor: 'postNowAction',
        });

        // Log publish attempt result
        await logPublishAttempt({
            actor: 'postNowAction',
            platform: post.platform || 'unknown',
            content_id: post.id,
            action: result.success ? 'posted' : 'failed',
            reason: result.success 
                ? `Successfully posted to ${post.platform}` 
                : `Failed to post: ${result.error}`,
            platform_response: {
                post_id: result.postId,
                error: result.error,
            },
        });

        // Phase 1: Error Monitoring - Record errors for auto-pause
        if (!result.success) {
            await recordPublishError(post.platform || 'unknown', result.error || 'Unknown error', post.id);
            
            // Check for auth failures
            const authCheck = await checkAuthFailures(post.platform || 'unknown');
            if (authCheck.shouldPause) {
                // Auto-pause will be handled by recordPublishError if threshold exceeded
                console.error(`[ERROR_MONITORING] Auth failures detected for ${post.platform}: ${authCheck.reason}`);
            }
        }

        if (result.success) {
            revalidatePath('/schedule');
        }
        return result;
       
    } catch (error: any) {
        // Release lock on error
        if (lockResult?.lockId && !lockReleased) {
            await releasePublishLock(lockResult.lockId).catch(console.error);
        }

        // Update attempt record with error
        if (idempotencyKey) {
            await recordPublishAttempt({
                idempotencyKey,
                content_id: post.id,
                platform: post.platform || 'unknown',
                status: 'failed',
                error: error.message,
                actor: 'postNowAction',
            }).catch(console.error);
        }

        console.error(`Error in postNowAction for ${post.platform}:`, error);
        
        // Phase 1: Error Monitoring - Record unexpected errors
        await recordPublishError(post.platform || 'unknown', error.message || 'Unexpected error', post.id).catch(console.error);
        
        return { success: false, error: `Could not post to ${post.platform}. ${error.message}` };
    }
}

export const saveFileAction = async (prevState: any, formData: FormData) => {
    const file = formData.get('file') as File;
    if (!file) {
        return { success: false, error: 'No file provided.', url: null };
    }

    try {
        const url = await saveFile(file);
        return { success: true, url: url, error: null };
    } catch (e: any) {
        return { success: false, error: e.message, url: null };
    }
}

// Reel Generation Action (No longer used by the form, but kept for reference)
const saveFile = async (file: File) => {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const fileExtension = path.extname(file.name);
  const filename = `automark/reels/${file.name.replace(
    fileExtension,
    ''
  )}-${uniqueSuffix}${fileExtension}`;
  
  const storageRef = ref(storage, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadBytes(storageRef, buffer, {
    contentType: file.type,
  });

  const downloadURL = await getDownloadURL(storageRef);
  return downloadURL;
};

export const generateReelAction = async (prevState: any, formData: FormData) => {
  const schema = z.object({
    vehicleMake: z.string().min(1, 'Vehicle make is required.'),
    vehicleModel: z.string().min(1, 'Vehicle model is required.'),
    packageName: z.string().min(1, 'Package name is required.'),
    servicePhotos: z
      .array(z.instanceof(File))
      .min(1, 'At least one service photo is required.'),
  });

  const rawData = Object.fromEntries(formData.entries());
  const servicePhotos = formData.getAll('servicePhotos').filter(f => (f as File).size > 0);

  const validated = schema.safeParse({
    ...rawData,
    servicePhotos,
  });

  if (!validated.success) {
    const errorMessages = Object.values(validated.error.flatten().fieldErrors)
      .flat()
      .join(' ');
    return {
      message: errorMessages || 'Invalid reel data.',
      videoUrl: null,
      error: true,
    };
  }
  
  try {
    const { vehicleMake, vehicleModel, packageName } = validated.data;
    const text = `A dynamic, exciting video reel showing off a ${vehicleMake} ${vehicleModel} that just received our ${packageName}. Show before and after shots, close-ups of the shine, and a final beauty shot.`;
    
    await Promise.all(
        validated.data.servicePhotos.map(file => saveFile(file))
    );

    const videoUrl = await generateReelFromText(text);

    if (!videoUrl) {
      throw new Error('Failed to get video URL from generation service.');
    }

    revalidatePath('/reels');
    return {
      message: 'Successfully generated video reel with HeyGen!',
      videoUrl: videoUrl,
      error: false,
    };
  } catch (e: any) {
    console.error('[REEL ACTION ERROR]', e);
    return {
      message: e.message || 'Failed to generate reel.',
      videoUrl: null,
      error: true,
    };
  }
};


// --- SMTP Settings Actions ---
const smtpSettingsSchema = z.object({
    host: z.string().min(1, 'SMTP Host is required.'),
    port: z.coerce.number().min(1, 'SMTP Port is required.'),
    user: z.string().min(1, 'SMTP User is required.'),
    pass: z.string().min(1, 'SMTP Password is required.'),
    from: z.string().email('A valid "From" email is required.'),
    senderName: z.string().min(1, 'Sender Name is required.'),
    encryption: z.enum(['none', 'ssl', 'tls']).default('none'),
});

export async function getSmtpSettings() {
    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'smtp');
        const docSnap = await getDoc(settingsRef);

        if (docSnap.exists()) {
            return { success: true, settings: docSnap.data(), error: null };
        } else {
            return { success: true, settings: null, error: 'No SMTP settings found.' };
        }
    } catch (e: any) {
        console.error('[ACTION_ERROR] getSmtpSettings:', e);
        return { success: false, settings: null, error: e.message };
    }
}

export async function saveSmtpSettings(prevState: any, formData: FormData) {
    const validated = smtpSettingsSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validated.success) {
        const message = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message };
    }

    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'smtp');
        await setDoc(settingsRef, validated.data, { merge: true });
        
        revalidatePath('/dashboard/settings');
        return { success: true, message: 'SMTP settings saved successfully!' };

    } catch (e: any) {
        console.error('[ACTION_ERROR] saveSmtpSettings:', e);
        return { success: false, message: e.message || 'Failed to save settings.' };
    }
}

// --- Twilio Settings Actions ---
const twilioSettingsSchema = z.object({
    accountSid: z.string().min(1, 'Twilio Account SID is required.'),
    authToken: z.string().min(1, 'Twilio Auth Token is required.'),
    fromNumber: z.string().min(1, 'Twilio phone number is required.'),
});

export async function getTwilioSettings() {
    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'twilio');
        const docSnap = await getDoc(settingsRef);

        if (docSnap.exists()) {
            return { success: true, settings: docSnap.data(), error: null };
        } else {
            return { success: true, settings: null, error: 'No Twilio settings found.' };
        }
    } catch (e: any) {
        console.error('[ACTION_ERROR] getTwilioSettings:', e);
        return { success: false, settings: null, error: e.message };
    }
}

export async function saveTwilioSettings(prevState: any, formData: FormData) {
    const validated = twilioSettingsSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validated.success) {
        const message = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message };
    }

    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'twilio');
        await setDoc(settingsRef, validated.data, { merge: true });
        
        revalidatePath('/dashboard/settings');
        return { success: true, message: 'Twilio settings saved successfully!' };

    } catch (e: any) {
        console.error('[ACTION_ERROR] saveTwilioSettings:', e);
        return { success: false, message: e.message || 'Failed to save settings.' };
    }
}

// --- Weather Settings Actions ---
const weatherSettingsSchema = z.object({
    apiKey: z.string().min(1, 'OpenWeatherMap API Key is required.'),
});

export async function getWeatherSettings() {
    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'weather');
        const docSnap = await getDoc(settingsRef);

        if (docSnap.exists()) {
            return { success: true, settings: docSnap.data(), error: null };
        } else {
            return { success: true, settings: null, error: 'No Weather settings found.' };
        }
    } catch (e: any) {
        console.error('[ACTION_ERROR] getWeatherSettings:', e);
        return { success: false, settings: null, error: e.message };
    }
}

export async function saveWeatherSettings(prevState: any, formData: FormData) {
    const validated = weatherSettingsSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validated.success) {
        const message = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message };
    }

    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'weather');
        await setDoc(settingsRef, validated.data, { merge: true });
        
        revalidatePath('/dashboard/settings');
        return { success: true, message: 'Weather settings saved successfully!' };

    } catch (e: any) {
        console.error('[ACTION_ERROR] saveWeatherSettings:', e);
        return { success: false, message: e.message || 'Failed to save settings.' };
    }
}

// --- Google Drive Settings Actions ---
const googleDriveSettingsSchema = z.object({
    clientId: z.string().min(1, 'Client ID is required.'),
    clientSecret: z.string().min(1, 'Client Secret is required.'),
    refreshToken: z.string().min(1, 'Refresh Token is required.'),
});

export async function getGoogleDriveSettings() {
    try {
        let data: Record<string, unknown> | null = null;
        if (isAdminSDKAvailable() && adminFirestore) {
            const docSnap = await adminFirestore.collection('settings').doc('googleDrive').get();
            data = docSnap.exists ? (docSnap.data() as Record<string, unknown>) : null;
        } else {
            const settingsRef = doc(galleryFirestore, 'settings', 'googleDrive');
            const docSnap = await getDoc(settingsRef);
            data = docSnap.exists() ? docSnap.data() : null;
        }
        if (data) {
            return { success: true, settings: data, error: null };
        }
        return { success: true, settings: null, error: 'No Google Drive settings found.' };
    } catch (e: any) {
        console.error('[ACTION_ERROR] getGoogleDriveSettings:', e);
        return { success: false, settings: null, error: e.message };
    }
}

export async function saveGoogleDriveSettings(prevState: any, formData: FormData) {
    const validated = googleDriveSettingsSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validated.success) {
        const message = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message };
    }

    try {
        // Use Admin SDK when available (Vercel/server) so write bypasses Firestore rules
        if (isAdminSDKAvailable() && adminFirestore) {
            await adminFirestore.collection('settings').doc('googleDrive').set(validated.data, { merge: true });
        } else {
            const settingsRef = doc(galleryFirestore, 'settings', 'googleDrive');
            await setDoc(settingsRef, validated.data, { merge: true });
        }

        revalidatePath('/dashboard/settings');
        return { success: true, message: 'Google Drive settings saved successfully!' };

    } catch (e: any) {
        console.error('[ACTION_ERROR] saveGoogleDriveSettings:', e);
        return { success: false, message: e.message || 'Failed to save settings.' };
    }
}


async function findOrCreateFolder(accessToken: string, name: string, parentId = 'root'): Promise<string> {
    // This helper function now lives inside the action that uses it to avoid being client-callable
    const query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and '${parentId}' in parents and trashed=false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`;
    
    const searchResponse = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!searchResponse.ok) {
         const errorData = await searchResponse.json();
         throw new Error(`Failed to search for folder '${name}': ${errorData.error.message}`);
    }
    const data = await searchResponse.json();
    if (data.files && data.files.length > 0) {
        return data.files[0].id;
    }

    // If not found, create it
    const fileMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : [],
    };
    const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fileMetadata),
    });
    if (!createResponse.ok) {
        const errorData = await createResponse.json();
        throw new Error(`Failed to create folder '${name}': ${errorData.error.message}`);
    }
    const createdFolder = await createResponse.json();
    return createdFolder.id;
}


export async function setupGoogleDriveFolders() {
    try {
        const creds = await getGoogleApiCredentials();
        const accessToken = await getRefreshedAccessToken(creds);

        const mainFolderName = "AutoMarkAI Shop Photos";
        const subFolders = [
            "After",
            "afterintro",
            "Before",
            "beforeintro",
            "contents",
            "Images To Animate",
            "Processed",
            "Processed Reels",
            "processed contents",
        ];

        const mainFolderId = await findOrCreateFolder(accessToken, mainFolderName, 'root');
        
        for (const folderName of subFolders) {
            await findOrCreateFolder(accessToken, folderName, mainFolderId);
        }

        return { success: true, message: 'Google Drive folder structure verified and created successfully.' };

    } catch (error: any) {
        console.error('Error in setupGoogleDriveFolders action:', error);
        return { success: false, message: error.message };
    }
}


// --- Cloudinary Settings Actions ---
const cloudinarySettingsSchema = z.object({
    cloud_name: z.string().min(1, 'Cloudinary Cloud Name is required.'),
    api_key: z.string().min(1, 'Cloudinary API Key is required.'),
    api_secret: z.string().min(1, 'Cloudinary API Secret is required.'),
});

export async function getCloudinarySettings() {
    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'cloudinary');
        const docSnap = await getDoc(settingsRef);

        if (docSnap.exists()) {
            return { success: true, settings: docSnap.data(), error: null };
        } else {
            return { success: true, settings: null, error: 'No Cloudinary settings found.' };
        }
    } catch (e: any) {
        console.error('[ACTION_ERROR] getCloudinarySettings:', e);
        return { success: false, settings: null, error: e.message };
    }
}

export async function saveCloudinarySettings(prevState: any, formData: FormData) {
    const validated = cloudinarySettingsSchema.safeParse(Object.fromEntries(formData.entries()));

    if (!validated.success) {
        const message = validated.error.errors.map(e => e.message).join(', ');
        return { success: false, message };
    }

    try {
        const settingsRef = doc(galleryFirestore, 'settings', 'cloudinary');
        await setDoc(settingsRef, validated.data, { merge: true });
        
        revalidatePath('/dashboard/settings');
        return { success: true, message: 'Cloudinary settings saved successfully!' };

    } catch (e: any) {
        console.error('[ACTION_ERROR] saveCloudinarySettings:', e);
        return { success: false, message: e.message || 'Failed to save settings.' };
    }
}


// --- Audio Generation ---
const MURF_API_KEY = "ap2_6102c63b-62c5-4a3f-8e6b-0d94cb0a9945";
const MURF_API_URL = 'https://api.murf.ai/v1/speech/generate';

export async function generateAudioAction(script: string): Promise<{ success: boolean, audioUrl?: string, error?: string }> {
    if (!MURF_API_KEY) {
        return { success: false, error: 'Murf.ai API key is not configured.' };
    }
    if (!script) {
        return { success: false, error: 'No script provided for audio generation.' };
    }
    
    try {
        console.log('Calling Murf.ai to generate speech...');
        const payload = {
            text: script,
            voiceId: 'en-US-natalie',
        };

        const response = await axios.post(MURF_API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'api-key': MURF_API_KEY,
            },
        });
        
        const audioUrl = response.data?.audioFile;
        if (!audioUrl) {
            console.error("Murf.ai response did not contain audioFile:", response.data);
            return { success: false, error: 'Failed to get audio file from Murf.ai.' };
        }

        console.log('Audio generated successfully by Murf.ai:', audioUrl);
        return { success: true, audioUrl: audioUrl };

    } catch (error: any) {
        console.error('❌ Error in generateAudioAction:', {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        
        const errorMessage = error.response?.data?.message || error.message || 'An unknown error occurred during audio generation.';
        return { success: false, error: errorMessage };
    }
}
