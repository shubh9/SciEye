import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { AppSession } from "@mentra/sdk";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const TEMP_AUDIO_DIR = path.join(process.cwd(), "temp_audio");
const PORT = parseInt(process.env.PORT || "3000");

// Ensure temp directory exists
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
  fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
}

export class ElevenLabsService {
  private client: ElevenLabsClient;
  private audioFiles: Map<string, string> = new Map();

  constructor() {
    this.client = new ElevenLabsClient({
      apiKey: ELEVENLABS_API_KEY,
    });
  }

  /**
   * Talk to user with ElevenLabs generated speech
   */
  async talktoem(session: AppSession, message: string): Promise<void> {
    try {
      if (!message || message.trim().length === 0) {
        session.logger.warn("⚠️ Empty message provided to talktoem");
        return;
      }

      // Truncate very long messages
      const truncatedMessage =
        message.length > 800 ? message.substring(0, 800) + "..." : message;

      session.logger.info(
        `🎙️ Generating speech for: "${truncatedMessage.substring(0, 50)}..."`
      );

      // Generate audio with fixed config
      const audioId = await this.generateAudio(
        truncatedMessage,
        session.logger
      );

      // Create audio URL
      const audioUrl = `${
        process.env.BASE_URL || `http://localhost:${PORT}`
      }/api/audio/${audioId}`;

      session.logger.info(`🔊 Playing generated audio at url: ${audioUrl}`);

      // Play the generated audio
      const result = await session.audio.playAudio({
        audioUrl: audioUrl,
      });

      if (result.success) {
        session.logger.info(`✅ Audio played successfully`);
        if (result.duration) {
          session.logger.info(`⏱️ Duration: ${result.duration} ms`);
        }

        // Clean up audio file after 5 minutes
        setTimeout(() => {
          this.deleteAudio(audioId);
        }, 5 * 60 * 1000);
      } else {
        session.logger.error(`❌ Audio playback failed: ${result.error}`);
      }
    } catch (error) {
      session.logger.error(`💥 Exception during speech generation: ${error}`);

      // Fallback to original static audio
      session.logger.info("🔄 Falling back to static audio");
      try {
        const fallbackResult = await session.audio.playAudio({
          audioUrl: "https://okgodoit.com/cool.mp3",
        });

        if (!fallbackResult.success) {
          session.logger.error(
            `❌ Fallback audio also failed: ${fallbackResult.error}`
          );
        }
      } catch (fallbackError) {
        session.logger.error(`💥 Fallback audio exception: ${fallbackError}`);
      }
    }
  }

  /**
   * Generate audio from text with fixed configuration
   */
  private async generateAudio(
    text: string,
    logger: AppSession["logger"]
  ): Promise<string> {
    const audioId = uuidv4();
    const filename = `${audioId}.mp3`;
    const filepath = path.join(TEMP_AUDIO_DIR, filename);

    // Fixed configuration for consistent voice
    const audioStream = await this.client.textToSpeech.convert(
      "JBFqnCBsd6RMkjVDRZzb", // George voice
      {
        text: text,
        modelId: "eleven_multilingual_v2",
        outputFormat: "mp3_44100_128",
        voiceSettings: {
          stability: 0.6,
          similarityBoost: 0.8,
          style: 0.2,
          useSpeakerBoost: true,
        },
      }
    );

    // Collect stream data into buffer
    const chunks: Uint8Array[] = [];
    const reader = audioStream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // Combine chunks into single buffer
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const audioData = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      audioData.set(chunk, offset);
      offset += chunk.length;
    }

    // Save audio to temporary file
    fs.writeFileSync(filepath, Buffer.from(audioData));

    // Store mapping
    this.audioFiles.set(audioId, filename);

    logger.info(`✅ Audio generated: ${filename}`);
    return audioId;
  }

  /**
   * Get audio file path by ID
   */
  getAudioFilePath(audioId: string): string | null {
    const filename = this.audioFiles.get(audioId);
    if (!filename) return null;

    const filepath = path.join(TEMP_AUDIO_DIR, filename);
    return fs.existsSync(filepath) ? filepath : null;
  }

  /**
   * Delete specific audio file
   */
  private deleteAudio(audioId: string): void {
    const filename = this.audioFiles.get(audioId);
    if (filename) {
      const filepath = path.join(TEMP_AUDIO_DIR, filename);
      try {
        if (fs.existsSync(filepath)) {
          fs.unlinkSync(filepath);
        }
        this.audioFiles.delete(audioId);
      } catch (error) {
        console.error(`Error deleting audio file ${filename}:`, error);
      }
    }
  }

  /**
   * Clean up old audio files
   */
  cleanupOldFiles(maxAgeMinutes: number = 30): void {
    const now = Date.now();
    const cutoff = now - maxAgeMinutes * 60 * 1000;

    try {
      const files = fs.readdirSync(TEMP_AUDIO_DIR);

      for (const file of files) {
        const filepath = path.join(TEMP_AUDIO_DIR, file);
        const stats = fs.statSync(filepath);

        if (stats.mtime.getTime() < cutoff) {
          fs.unlinkSync(filepath);
          // Remove from tracking map
          for (const [audioId, filename] of this.audioFiles.entries()) {
            if (filename === file) {
              this.audioFiles.delete(audioId);
              break;
            }
          }
        }
      }
    } catch (error) {
      console.error("Error cleaning up audio files:", error);
    }
  }
}
