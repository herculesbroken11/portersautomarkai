
import { NextRequest, NextResponse } from 'next/server';
import { doc, collection, writeBatch, query, where, getDocs, limit } from 'firebase/firestore';
import { galleryFirestore, storage } from '@/firebase/config';
import { adminFirestore, isAdminSDKAvailable } from '@/firebase/admin';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { generateCaptions as generateReplicateCaptions } from '@/ai/replicate';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

// Helper to create a streaming response
function createStreamingResponse() {
    const stream = new ReadableStream({
        start(controller) {
            // The controller is automatically closed when the function finishes.
        },
    });

    const send = (data: object) => {
        const encoder = new TextEncoder();
        const chunk = encoder.encode(JSON.stringify(data) + '\n');
        stream.readable.getReader().read().then(({ done, value }) => {
            if (done) return;
             // This is not a correct way to write to a stream from outside.
             // We will handle the writing inside an async function passed to the stream constructor.
        });
    };
    // This is not a correct way to construct a streaming response. A better pattern is needed.
    return { stream, send };
}

import { getGoogleApiCredentials, getRefreshedAccessToken, GoogleDriveAuthError } from '@/lib/google-drive-auth';

// Helper to get the descriptive path of a folder
async function getFolderPath(accessToken: string, folderId: string): Promise<string> {
    let path: string[] = [];
    let currentId: string | null = folderId;

    // Stop when we reach the root or a folder we can't access
    while (currentId) {
        const fileUrl = `https://www.googleapis.com/drive/v3/files/${currentId}?fields=id,name,parents`;
        const fileResponse = await fetch(fileUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

        if (!fileResponse.ok) break;

        const fileData = await fileResponse.json();
        
        // Stop if we hit the main folder or 'My Drive'
        if (fileData.name === 'detailing pics' || fileData.name === 'My Drive') break;

        path.unshift(fileData.name);
        currentId = fileData.parents && fileData.parents.length > 0 ? fileData.parents[0] : null;
    }
    
    return path.join(' / ');
}


export async function GET(request: NextRequest) {
    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            const send = (data: object) => {
                controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
            };

            try {
                send({ log: "Starting automated video process..." });
                const creds = await getGoogleApiCredentials();
                const accessToken = await getRefreshedAccessToken(creds);
                send({ log: "Successfully authenticated with Google Drive." });

                // Find the main "detailing pics" folder
                const mainFolderQuery = `mimeType='application/vnd.google-apps.folder' and name='detailing pics' and 'root' in parents and trashed=false`;
                const mainFolderRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(mainFolderQuery)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
                if(!mainFolderRes.ok) throw new Error("Could not find 'detailing pics' folder.");
                const mainFolderData = await mainFolderRes.json();
                if(!mainFolderData.files || mainFolderData.files.length === 0) throw new Error("'detailing pics' folder not found.");
                const mainFolderId = mainFolderData.files[0].id;
                send({ log: `Found 'detailing pics' folder (ID: ${mainFolderId}).` });

                // Find all 'Videos' subfolders
                const videosFolderQuery = `mimeType='application/vnd.google-apps.folder' and name = 'Videos' and trashed=false`;
                const videosFolderRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(videosFolderQuery)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
                 if(!videosFolderRes.ok) throw new Error("Failed to search for 'Videos' folders.");
                const videosFolderData = await videosFolderRes.json();
                const videoFolders = videosFolderData.files || [];
                if (videoFolders.length === 0) {
                    send({ log: "No 'Videos' folders found. Exiting." });
                    controller.close();
                    return;
                }
                send({ log: `Found ${videoFolders.length} 'Videos' folders. Searching for a new video...` });
                videoFolders.sort(() => Math.random() - 0.5); // Shuffle for randomness

                let latestVideo = null;
                let foundInFolderId = null;

                 for (const folder of videoFolders) {
                    send({ log: `Scanning folder: ${folder.name} (ID: ${folder.id})`});
                    const videoQuery = `'${folder.id}' in parents and trashed=false and (mimeType='video/mp4' or mimeType='video/quicktime' or mimeType='video/webm') and not mimeType contains 'google-apps'`;
                    const videoRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(videoQuery)}&orderBy=createdTime desc&pageSize=1`, { headers: { Authorization: `Bearer ${accessToken}` } });
                    if (!videoRes.ok) continue;
                    const videoData = await videoRes.json();
                    if (videoData.files && videoData.files.length > 0) {
                        // Check if this video has been processed
                        const driveId = videoData.files[0].id;
                        let alreadyProcessed = false;
                        if (isAdminSDKAvailable() && adminFirestore) {
                            const postSnap = await adminFirestore.collection('posts').where('originalDriveId', '==', driveId).limit(1).get();
                            alreadyProcessed = !postSnap.empty;
                        } else {
                            const postExistsQuery = query(collection(galleryFirestore, 'posts'), where('originalDriveId', '==', driveId), limit(1));
                            const postSnapshot = await getDocs(postExistsQuery);
                            alreadyProcessed = !postSnapshot.empty;
                        }
                        if (!alreadyProcessed) {
                            latestVideo = videoData.files[0];
                            foundInFolderId = folder.id;
                            break;
                        } else {
                            send({ log: `Video ${videoData.files[0].name} already processed. Skipping.` });
                        }
                    }
                }

                if (!latestVideo || !foundInFolderId) {
                    send({ log: "No new, unprocessed videos found in any 'Videos' folder. Exiting." });
                    controller.close();
                    return;
                }
                
                const vehicleName = await getFolderPath(accessToken, latestVideo.parents[0]);
                send({ log: `Found new video: ${latestVideo.name}. Using context: "${vehicleName}"` });

                // Download video
                send({ log: `Downloading video from Drive...`});
                const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${latestVideo.id}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
                if (!downloadRes.ok) throw new Error("Failed to download video file.");
                const videoBlob = await downloadRes.blob();

                // Generate Captions (using a simple placeholder for now to avoid long AI calls in this example)
                const platforms = 'all'; 
                send({ log: `Generating captions for ${platforms === 'youtube' ? 'YouTube only' : 'all platforms'}...` });
                const captions = await generateReplicateCaptions({ vehicle: vehicleName, service: "Video Showcase", package: "N/A", platforms });
                if (!captions || captions.length === 0) throw new Error("AI failed to generate captions.");
                send({ log: `Generated ${captions.length} captions.` });

                // Upload to Firebase Storage
                send({ log: "Uploading video to Firebase Storage..." });
                const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
                const finalFilename = `automark/reels/video-${uniqueSuffix}.mp4`;
                const videoStorageRef = storageRef(storage, finalFilename);
                await uploadBytes(videoStorageRef, videoBlob);
                const downloadURL = await getDownloadURL(videoStorageRef);
                send({ log: "Upload complete."});

                // Save to Firestore
                const postPayload = {
                    videoUrl: downloadURL,
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    vehicle: vehicleName,
                    service: 'Video Showcase',
                    originalDriveId: latestVideo.id,
                };
                if (isAdminSDKAvailable() && adminFirestore) {
                    const batch = adminFirestore.batch();
                    for (const post of captions) {
                        const newPostRef = adminFirestore.collection('posts').doc();
                        batch.set(newPostRef, {
                            ...postPayload,
                            platform: post.platform,
                            text: post.text,
                            hashtags: post.hashtags || [],
                        });
                    }
                    await batch.commit();
                } else {
                    const batch = writeBatch(galleryFirestore);
                    for (const post of captions) {
                        const newPostRef = doc(collection(galleryFirestore, 'posts'));
                        batch.set(newPostRef, {
                            ...postPayload,
                            platform: post.platform,
                            text: post.text,
                            hashtags: post.hashtags || [],
                        });
                    }
                    await batch.commit();
                }
                send({ log: `Successfully saved ${captions.length} posts for approval.`});

                send({ log: "Process complete!" });
                
            } catch (error) {
                if (error instanceof GoogleDriveAuthError) {
                    send({ error: error.message, code: error.code });
                } else {
                    console.error('[CRON_GENERATE_REEL_ERROR]', error);
                    send({ error: `An unexpected error occurred: ${error instanceof Error ? error.message : String(error)}` });
                }
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}
