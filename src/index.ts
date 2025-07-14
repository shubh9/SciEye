import {
  AppServer,
  AppSession,
  ViewType,
  AuthenticatedRequest,
  PhotoData,
} from "@mentra/sdk";
import { Request, Response } from "express";
import * as ejs from "ejs";
import * as path from "path";
import { saveImageToNotion, saveToNotion } from "./notionService";
import { ElevenLabsService } from "./elevenLabsService";

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

const PACKAGE_NAME =
  process.env.PACKAGE_NAME ??
  (() => {
    throw new Error("PACKAGE_NAME is not set in .env file");
  })();
const MENTRAOS_API_KEY =
  process.env.MENTRAOS_API_KEY ??
  (() => {
    throw new Error("MENTRAOS_API_KEY is not set in .env file");
  })();
const PORT = parseInt(process.env.PORT || "3000");

/**
 * Photo Taker App with webview functionality for displaying photos
 * Extends AppServer to provide photo taking and webview display capabilities
 */
class ExampleMentraOSApp extends AppServer {
  private photos: Map<string, StoredPhoto> = new Map(); // Store photos by userId
  private latestPhotoTimestamp: Map<string, number> = new Map(); // Track latest photo timestamp per user
  private isStreamingPhotos: Map<string, boolean> = new Map(); // Track if we are streaming photos for a user
  private nextPhotoTime: Map<string, number> = new Map(); // Track next photo time for a user

  // NEW: Voice note state tracking
  private isRecordingNote: Map<string, boolean> = new Map(); // Track if we are recording a voice note for a user
  private noteBuffer: Map<string, string> = new Map(); // Buffer to accumulate voice note text per user

  // NEW: Track pending photo requests to prevent concurrent requests
  private pendingPhotoRequest: Map<string, boolean> = new Map(); // Track if a photo request is pending for a user

  // ElevenLabs service for text-to-speech
  private elevenLabsService: ElevenLabsService;

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });

    this.elevenLabsService = new ElevenLabsService();
    this.setupWebviewRoutes();
    this.setupCleanupTasks();
  }

  /**
   * Setup periodic cleanup tasks
   */
  private setupCleanupTasks(): void {
    // Clean up old audio files every 15 minutes
    setInterval(() => {
      this.elevenLabsService.cleanupOldFiles(30);
    }, 15 * 60 * 1000);
  }

  /**
   * Helper function to talk to users using ElevenLabs generated speech
   * @param session - The app session
   * @param message - The message to convert to speech
   */
  private async talktoem(session: AppSession, message: string): Promise<void> {
    await this.elevenLabsService.talktoem(session, message);
  }

  /**
   * Handle new session creation and button press events
   */
  protected async onSession(
    session: AppSession,
    sessionId: string,
    userId: string
  ): Promise<void> {
    // this gets called whenever a user launches the app

    this.logger.info(`Session started for user ${userId}`);
    await this.talktoem(session, "Session started");

    // Voice activation – use the official onTranscription syntax
    this.logger.info(`Setting up transcription listener for user ${userId}`);
    const unsubscribeTranscription = session.events.onTranscription(
      async (data) => {
        // Ignore interim chunks; only process final transcriptions
        if (!data.isFinal) return;

        const spokenText = data.text.toLowerCase().trim();
        const originalText = data.text.trim(); // Keep original for note content
        session.logger.debug(`Heard: "${spokenText}"`);

        // Check if we're currently recording a note
        if (this.isRecordingNote.get(userId)) {
          // Check for end note command
          if (
            spokenText.includes("end note") ||
            spokenText.includes("endnote") ||
            spokenText.includes("stop note")
          ) {
            session.logger.info("🎤 Voice note recording ended");
            this.endVoiceNote(session, userId);
            return;
          }

          // Accumulate the spoken text (exclude the "end note" command itself)
          this.accumulateNoteText(userId, originalText);
          return;
        }

        // Voice note commands (only when not recording)
        if (spokenText.includes("start note")) {
          session.logger.info("🎤 Voice note recording started");
          await this.talktoem(session, "Listening!");
          this.startVoiceNote(session, userId);
          return;
        }

        // Activation phrase: "computer" – reply with a greeting
        if (spokenText.includes("computer")) {
          session.logger.info('✨ Activation phrase "computer" detected!');
          await this.talktoem(session, "Hello World");
        }

        // Activation phrase: "take photo" – capture a photo and save to Notion
        if (spokenText.includes("take photo")) {
          session.logger.info('✨ Activation phrase "take photo" detected!');

          // Extract title from the same sentence
          const titleMatch = spokenText.match(/take photo\s*(.+)/);
          const title = titleMatch ? titleMatch[1].trim() : undefined;

          this.takePhotoforNotion(session, userId, title);
        }
      }
    );

    // Handle WebSocket disconnections to stop camera work
    const unsubscribeDisconnected = session.events.onDisconnected(() => {
      this.logger.warn(`🔌 WebSocket disconnected for user ${userId}`);

      // Stop any ongoing camera work
      this.isStreamingPhotos.set(userId, false);
      this.isRecordingNote.set(userId, false);
      this.pendingPhotoRequest.set(userId, false);

      // Clear buffers and timers
      this.noteBuffer.delete(userId);
      this.nextPhotoTime.delete(userId);

      this.logger.info(
        `📸 Camera work stopped for disconnected user ${userId}`
      );
    });

    // Ensure the listeners are removed when the session ends
    this.addCleanupHandler(unsubscribeTranscription);
    this.addCleanupHandler(unsubscribeDisconnected);
    this.logger.info(
      `✅ Transcription and disconnection listeners successfully set up for user ${userId}`
    );

    // set the initial state of the user
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.set(userId, Date.now());
    this.isRecordingNote.set(userId, false);
    this.noteBuffer.set(userId, "");
    this.pendingPhotoRequest.set(userId, false);

    // this gets called whenever a user presses a button
    session.events.onButtonPress(async (button) => {
      this.logger.info(
        `Button pressed: ${button.buttonId}, type: ${button.pressType}`
      );

      if (button.pressType === "long") {
        // the user held the button, so we toggle the streaming mode
        this.isStreamingPhotos.set(userId, !this.isStreamingPhotos.get(userId));
        this.logger.info(
          `Streaming photos for user ${userId} is now ${this.isStreamingPhotos.get(
            userId
          )}`
        );
        return;
      } else {
        // the user pressed the button, so we take a single photo
        try {
          // Check if a photo request is already pending
          if (this.pendingPhotoRequest.get(userId)) {
            this.logger.info(
              `Photo request dropped for user ${userId} - another request is already pending`
            );
            return;
          }

          // Set the pending flag
          this.pendingPhotoRequest.set(userId, true);

          // first, get the photo
          const photo = await session.camera.requestPhoto();
          // if there was an error, log it
          this.logger.info(
            `Photo taken for user ${userId}, timestamp: ${photo.timestamp}`
          );
          this.cachePhoto(photo, userId);
        } catch (error) {
          this.logger.error(`Error taking photo: ${error}`);
        } finally {
          // Always clear the pending flag
          this.pendingPhotoRequest.set(userId, false);
        }
      }
    });

    // repeatedly check if we are in streaming mode and if we are ready to take another photo
    setInterval(async () => {
      if (
        this.isStreamingPhotos.get(userId) &&
        Date.now() > (this.nextPhotoTime.get(userId) ?? 0)
      ) {
        try {
          // Check if a photo request is already pending
          if (this.pendingPhotoRequest.get(userId)) {
            this.logger.info(
              `Streaming photo request dropped for user ${userId} - another request is already pending`
            );
            return;
          }

          // Set the pending flag
          this.pendingPhotoRequest.set(userId, true);

          // set the next photos for 30 seconds from now, as a fallback if this fails
          this.nextPhotoTime.set(userId, Date.now() + 30000);

          // actually take the photo
          const photo = await session.camera.requestPhoto();

          // set the next photo time to now, since we are ready to take another photo
          this.nextPhotoTime.set(userId, Date.now());

          // cache the photo for display
          this.cachePhoto(photo, userId);
        } catch (error) {
          this.logger.error(`Error auto-taking photo: ${error}`);
        } finally {
          // Always clear the pending flag
          this.pendingPhotoRequest.set(userId, false);
        }
      }
    }, 1000);
  }

  protected async onStop(
    sessionId: string,
    userId: string,
    reason: string
  ): Promise<void> {
    // clean up the user's state
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.delete(userId);

    // Clean up voice note state
    this.isRecordingNote.set(userId, false);
    this.noteBuffer.delete(userId);

    // Clean up photo request state
    this.pendingPhotoRequest.set(userId, false);

    this.logger.info(`Session stopped for user ${userId}, reason: ${reason}`);
  }

  /**
   * Cache a photo for display
   */
  private async cachePhoto(photo: PhotoData, userId: string) {
    // create a new stored photo object which includes the photo data and the user id
    const cachedPhoto: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId: userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size,
    };

    // this example app simply stores the photo in memory for display in the webview, but you could also send the photo to an AI api,
    // or store it in a database or cloud storage, send it to roboflow, or do other processing here

    // cache the photo for display
    this.photos.set(userId, cachedPhoto);
    // update the latest photo timestamp
    this.latestPhotoTimestamp.set(userId, cachedPhoto.timestamp.getTime());
    this.logger.info(
      `Photo cached for user ${userId}, timestamp: ${cachedPhoto.timestamp}`
    );
  }

  // NEW: Helper to take a photo, cache it, and save the image to Notion
  private async takePhotoforNotion(
    session: AppSession,
    userId: string,
    title?: string
  ): Promise<void> {
    try {
      this.logger.info(`takePhotoforNotion invoked for user ${userId}`);

      // Check if a photo request is already pending
      if (this.pendingPhotoRequest.get(userId)) {
        this.logger.info(
          `Photo request for Notion dropped for user ${userId} - another request is already pending`
        );
        return;
      }

      // Set the pending flag
      this.pendingPhotoRequest.set(userId, true);

      const photo = await session.camera.requestPhoto();
      await this.cachePhoto(photo, userId);
      await saveImageToNotion(photo, title);
      await this.talktoem(session, "Photo saved to Notion!");
    } catch (error) {
      this.logger.error(`Error in takePhotoforNotion: ${error}`);
    } finally {
      // Always clear the pending flag
      this.pendingPhotoRequest.set(userId, false);
    }
  }

  /**
   * Start recording a voice note for the given user
   */
  private startVoiceNote(session: AppSession, userId: string): void {
    this.isRecordingNote.set(userId, true);
    this.noteBuffer.set(userId, "");
    console.log("Voice note recording started. Say 'end note' when finished.");
  }

  /**
   * Accumulate text for the current voice note
   */
  private accumulateNoteText(userId: string, text: string): void {
    const currentBuffer = this.noteBuffer.get(userId) || "";
    const updatedBuffer = currentBuffer + (currentBuffer ? " " : "") + text;
    this.noteBuffer.set(userId, updatedBuffer);

    this.logger.debug(
      `Voice note buffer for user ${userId}: "${updatedBuffer}"`
    );
  }

  /**
   * End voice note recording and save to Notion
   */
  private async endVoiceNote(
    session: AppSession,
    userId: string
  ): Promise<void> {
    try {
      const noteContent = this.noteBuffer.get(userId) || "";

      if (!noteContent.trim()) {
        console.log("No content recorded for the voice note.");
        return;
      }

      // Save the voice note to Notion with formatting
      await this.saveVoiceNoteToNotion(noteContent, userId);

      // Reset recording state
      this.isRecordingNote.set(userId, false);
      this.noteBuffer.set(userId, "");

      console.log("Voice note saved to Notion!");
      this.logger.info(
        `Voice note saved for user ${userId}, content length: ${noteContent.length}`
      );
      await this.talktoem(session, "Got it");
    } catch (error) {
      this.logger.error(`Error saving voice note: ${error}`);
      console.log("Sorry, there was an error saving your voice note.");
    }
  }

  /**
   * Save the voice note to Notion with proper formatting
   */
  private async saveVoiceNoteToNotion(
    content: string,
    userId: string
  ): Promise<void> {
    const timestamp = new Date().toLocaleString();
    const formattedNote = `📝 Voice Note (${timestamp})\n\n${content}`;

    await saveToNotion(formattedNote);
  }

  /**
   * Set up webview routes for photo display functionality
   */
  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    // Audio serving endpoint for ElevenLabs generated audio
    app.get("/api/audio/:audioId", (req: any, res: any) => {
      const audioId = req.params.audioId;

      try {
        const audioPath = this.elevenLabsService.getAudioFilePath(audioId);

        if (!audioPath) {
          res.status(404).json({ error: "Audio file not found" });
          return;
        }

        // Set appropriate headers for audio streaming
        res.set({
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        });

        // Stream the audio file
        const fs = require("fs");
        const stream = fs.createReadStream(audioPath);
        stream.pipe(res);

        stream.on("error", (err: any) => {
          console.error("Error streaming audio:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: "Error streaming audio" });
          }
        });
      } catch (error) {
        console.error("Error serving audio:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // API endpoint to get the latest photo for the authenticated user
    app.get("/api/latest-photo", (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo) {
        res.status(404).json({ error: "No photo available" });
        return;
      }

      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true,
      });
    });

    // API endpoint to get photo data
    app.get("/api/photo/:requestId", (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const requestId = req.params.requestId;

      if (!userId) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const photo = this.photos.get(userId);
      if (!photo || photo.requestId !== requestId) {
        res.status(404).json({ error: "Photo not found" });
        return;
      }

      res.set({
        "Content-Type": photo.mimeType,
        "Cache-Control": "no-cache",
      });
      res.send(photo.buffer);
    });

    // Main webview route - displays the photo viewer interface
    app.get("/webview", async (req: any, res: any) => {
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

      const templatePath = path.join(
        process.cwd(),
        "views",
        "photo-viewer.ejs"
      );
      const html = await ejs.renderFile(templatePath, {});
      res.send(html);
    });
  }
}

// Start the server
// DEV CONSOLE URL: https://console.mentra.glass/
// Get your webhook URL from ngrok (or whatever public URL you have)
const app = new ExampleMentraOSApp();

app.start().catch(console.error);
