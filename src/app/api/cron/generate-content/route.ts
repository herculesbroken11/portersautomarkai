
import { NextResponse } from 'next/server';
import { collection, query, where, getDocs, limit, doc, updateDoc, addDoc } from 'firebase/firestore';
import { galleryFirestore } from '@/firebase/config';
import { adminFirestore, isAdminSDKAvailable } from '@/firebase/admin';
import { generateCaptions } from '@/ai/replicate';

// This function processes a single gallery item: stitches images and generates content.
async function processGalleryItem(item: any) {
    // Step 1: Stitch images by calling the existing API route
    // Note: In a production environment, you might want to call this function directly
    // instead of making an HTTP request to your own API.
    const imageResponse = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/image/overlay-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            beforeUrl: item.beforeImageUrl,
            afterUrl: item.afterImageUrl,
        }),
    });

    const imageResult = await imageResponse.json();
    if (imageResult.error) {
        throw new Error(`Image Stitching Failed for ${item.id}: ${imageResult.message}`);
    }
    const stitchedImageUrl = imageResult.stitchedImageUrl;

    // Step 2: Generate captions for the stitched image
    const captions = await generateCaptions({
        vehicle: item.title,
        service: item.category,
        package: item.description || 'Not specified',
        location: 'Your Location', // This can be made dynamic later
        isCron: true,
    });

    // Step 3: Save generated posts to the 'posts' collection
    const postData = {
        vehicle: item.title,
        service: item.category,
        package: item.description,
        stitchedImageUrl: stitchedImageUrl,
        status: 'pending',
        createdAt: new Date().toISOString(),
        originalGalleryId: item.id,
    };
    if (isAdminSDKAvailable() && adminFirestore) {
        for (const post of captions) {
            await adminFirestore.collection('posts').add({ ...post, ...postData });
        }
        await adminFirestore.collection('gallery').doc(item.id).update({ isGenerated: true });
    } else {
        for (const post of captions) {
            await addDoc(collection(galleryFirestore, 'posts'), { ...post, ...postData });
        }
        const galleryItemRef = doc(galleryFirestore, 'gallery', item.id);
        await updateDoc(galleryItemRef, { isGenerated: true });
    }

    // Step 4: Mark the gallery item as generated (done above in both branches)
    
    return `Successfully generated ${captions.length} posts for gallery item: ${item.title} (${item.id})`;
}


export async function GET(request: Request) {
    const logs: string[] = [];

    // Secure the endpoint with a secret key
    const authToken = (request.headers.get('authorization') || '').split('Bearer ').at(1);
    if (process.env.CRON_SECRET && authToken !== process.env.CRON_SECRET) {
        logs.push('Authentication failed: Invalid cron secret.');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    try {
        logs.push('Cron job started: Looking for a gallery item to process...');

        let docs: { id: string; data: () => Record<string, unknown> }[] = [];
        const useAdmin = isAdminSDKAvailable() && adminFirestore;

        if (useAdmin) {
            // Query 1: Look for items explicitly marked as not generated.
            const snap1 = await adminFirestore!.collection('gallery')
                .where('isBeforeAfter', '==', true)
                .where('isGenerated', '==', false)
                .limit(1)
                .get();
            if (!snap1.empty) {
                docs = snap1.docs.map(d => ({ id: d.id, data: d.data }));
            } else {
                // Query 2: Items where isGenerated doesn't exist or isn't true.
                const snap2 = await adminFirestore!.collection('gallery')
                    .where('isBeforeAfter', '==', true)
                    .limit(20)
                    .get();
                const unprocessed = snap2.docs.find(d => d.data().isGenerated !== true);
                if (unprocessed) docs = [{ id: unprocessed.id, data: unprocessed.data }];
            }
        } else {
            const queryGeneratedFalse = query(
                collection(galleryFirestore, 'gallery'),
                where('isBeforeAfter', '==', true),
                where('isGenerated', '==', false),
                limit(1)
            );
            const querySnapshot = await getDocs(queryGeneratedFalse);
            if (!querySnapshot.empty) {
                docs = querySnapshot.docs.map(d => ({ id: d.id, data: d.data }));
            } else {
                const allBeforeAfterQuery = query(
                    collection(galleryFirestore, 'gallery'),
                    where('isBeforeAfter', '==', true),
                    limit(20)
                );
                const allDocsSnapshot = await getDocs(allBeforeAfterQuery);
                const unprocessedDoc = allDocsSnapshot.docs.find(d => d.data().isGenerated !== true);
                if (unprocessedDoc) {
                    docs = [{ id: unprocessedDoc.id, data: unprocessedDoc.data }];
                }
            }
        }

        if (docs.length === 0) {
            logs.push('No new gallery items to generate content from.');
            return NextResponse.json({ message: 'No new gallery items found.', logs });
        }

        const galleryDoc = docs[0];
        const item = { id: galleryDoc.id, ...galleryDoc.data() } as any;

        logs.push(`Found gallery item to process: ${item.title} (ID: ${item.id})`);

        const resultMessage = await processGalleryItem(item);
        logs.push(resultMessage);

        return NextResponse.json({ message: 'Content generation process completed.', logs });
    } catch (error: any) {
        console.error('[CRON_GENERATE_ERROR]', error);
        logs.push(`An unexpected error occurred: ${error.message}`);
        return NextResponse.json({ error: 'An unexpected error occurred during the content generation cron job.', logs }, { status: 500 });
    }
}
