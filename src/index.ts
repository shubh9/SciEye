import { AppServer, AppSession, ViewType, AuthenticatedRequest } from '@mentra/sdk';
import { Request, Response } from 'express';
import { PhotoData } from '../../AugmentOS/augmentos_cloud/packages/sdk/dist/types';

/**
 * Interface representing a stored photo with metadata
 */
interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');

/**
 * Photo Taker App with webview functionality for displaying photos
 * Extends AppServer to provide photo taking and webview display capabilities
 */
class ExampleMentraOSApp extends AppServer {
  private photos: Map<string, StoredPhoto> = new Map(); // Store photos by userId
  private latestPhotoTimestamp: Map<string, number> = new Map(); // Track latest photo timestamp per user

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });

    this.setupWebviewRoutes();
  }

    /**
   * Set up webview routes for photo display functionality
   */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // Main webview route - displays the photo viewer interface
    app.get('/webview', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).send(`
          <html>
            <head><title>Photo Viewer - Not Authenticated</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
        return;
      }

      // Serve the photo viewer HTML interface
      res.send(this.getPhotoViewerHTML());
    });

    // API endpoint to get the latest photo for the authenticated user
    app.get('/api/latest-photo', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo) {
        res.status(404).json({ error: 'No photo available' });
        return;
      }

      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true
      });
    });

    // API endpoint to get photo data
    app.get('/api/photo/:requestId', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const requestId = req.params.requestId;

      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo || photo.requestId !== requestId) {
        res.status(404).json({ error: 'Photo not found' });
        return;
      }

      res.set({
        'Content-Type': photo.mimeType,
        'Cache-Control': 'no-cache'
      });
      res.send(photo.buffer);
    });
  }

    /**
   * Generate HTML for the photo viewer interface with auto-refresh functionality
   */
  private getPhotoViewerHTML(): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Photo Viewer</title>
        <style>
          body {
            margin: 0;
            padding: 0;
            background-color: #000;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: Arial, sans-serif;
          }

          .photo-container {
            max-width: 100vw;
            max-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
          }

          .photo {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            border-radius: 8px;
          }

          .no-photo {
            color: white;
            text-align: center;
            font-size: 18px;
          }

          .loading {
            color: white;
            text-align: center;
            font-size: 16px;
          }
        </style>
      </head>
      <body>
        <div class="photo-container">
          <div id="content" class="loading">Loading latest photo...</div>
        </div>

        <script>
          let currentRequestId = null;

          /**
           * Check for new photos and update display
           */
          async function checkForNewPhoto() {
            try {
              const response = await fetch('/api/latest-photo');

              if (response.status === 404) {
                // No photo available
                document.getElementById('content').innerHTML =
                  '<div class="no-photo">No photos taken yet. Take a photo using your MentraOS device!</div>';
                return;
              }

              if (!response.ok) {
                throw new Error('Failed to fetch photo info');
              }

              const photoInfo = await response.json();

              // Check if this is a new photo
              if (photoInfo.requestId !== currentRequestId) {
                currentRequestId = photoInfo.requestId;

                // Update the display with new photo
                document.getElementById('content').innerHTML =
                  '<img class="photo" src="/api/photo/' + photoInfo.requestId + '" alt="Latest Photo" />';
              }
            } catch (error) {
              console.error('Error checking for new photo:', error);
              document.getElementById('content').innerHTML =
                '<div class="no-photo">Error loading photo. Please refresh the page.</div>';
            }
          }

          // Check for new photos every 500ms (twice per second)
          checkForNewPhoto(); // Initial check
          setInterval(checkForNewPhoto, 500);
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Handle new session creation and button press events
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.info(`Session started for user ${userId}`);

  // check if we have a camera
  if (!session.capabilities?.hasCamera) {
    this.logger.warn('Camera not available');
    return;
  }


    session.events.onButtonPress(async (button) => {
      this.logger.info(`Button pressed: ${button.buttonId}, type: ${button.pressType}`);
     /* session.stopAudio();

      try {
        const playresult = session.playAudio({audioUrl: 'https://parrot-samples.s3.amazonaws.com/kettle/charles.wav', volume: 0.5});

        playresult.then(()=>this.logger.info('Audio play finished'));
        playresult.catch((error)=>this.logger.error(`Error playing audio: ${error}`));
      } catch (error) {
        this.logger.error(`Error playing audio: ${error}`);
      }*/


      this.takePhoto(session, userId);


    });
  }

  private async takePhoto(session: AppSession, userId: string) {

    const photoRequest = session.camera.requestPhoto();
    photoRequest.catch((error)=>this.logger.error(`Error taking photo: ${error}`));
    photoRequest.then((photo) => {
      this.logger.info(`Photo taken for user ${userId}, timestamp: ${photo.timestamp}`);
      this.storePhoto(photo, userId);
    });
  }

  private async storePhoto(photo: PhotoData, userId: string) {
    const storedPhoto: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId: userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size
    };
    this.photos.set(userId, storedPhoto);
    this.latestPhotoTimestamp.set(userId, storedPhoto.timestamp.getTime());
    this.logger.info(`Photo stored for user ${userId}, timestamp: ${storedPhoto.timestamp}`);
  }
}



// Start the server
// DEV CONSOLE URL: https://console.mentra.glass/
// Get your webhook URL from ngrok (or whatever public URL you have)
const app = new ExampleMentraOSApp();

app.start().catch(console.error);