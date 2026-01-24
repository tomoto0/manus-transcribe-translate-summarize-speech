import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { invokeLLM } from "./llm";

// In-memory session storage for temporary data
const sessionData: Record<
  string,
  {
    transcript: string;
    deepgramCalls: number;
    accumulatedSize: number;
    language: string;
  }
> = {};

// Deepgram API configuration
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";

async function transcribeWithDeepgram(audioBuffer: Buffer, language: string = "en"): Promise<string | null> {
  try {
    if (!DEEPGRAM_API_KEY) {
      console.error("[DEEPGRAM ERROR] API key not found");
      return null;
    }

    if (audioBuffer.length < 1000) {
      console.warn(`[DEEPGRAM WARNING] Audio data too small: ${audioBuffer.length} bytes`);
      return null;
    }

    const headers = {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/webm",
    };

    console.log(`[DEEPGRAM] Using language: ${language}`);
    const params = new URLSearchParams({
      model: "nova-2",
      smart_format: "true",
      language: language,
      punctuate: "true",
      diarize: "false",
    });

    const response = await fetch(`${DEEPGRAM_URL}?${params.toString()}`, {
      method: "POST",
      headers,
      body: audioBuffer as unknown as BodyInit,
    });

    if (response.status === 200) {
      const result = await response.json();
      const channels = result.results?.channels || [];
      if (channels.length > 0) {
        const alternatives = channels[0].alternatives || [];
        if (alternatives.length > 0) {
          const transcript = alternatives[0].transcript || "";
          if (transcript.trim()) {
            console.log(`[DEEPGRAM SUCCESS] Transcribed: ${transcript.substring(0, 50)}...`);
            return transcript.trim();
          }
        }
      }
      return null;
    } else {
      console.error(`[DEEPGRAM ERROR] Status: ${response.status}`);
      return null;
    }
  } catch (error) {
    console.error(`[DEEPGRAM ERROR] Exception: ${error}`);
    return null;
  }
}

function getSummaryPrompt(
  summaryType: string,
  transcript: string,
  summaryLanguage: string = "en"
): string {
  const languageInstructions: Record<string, string> = {
    ja: "日本語で要約してください。",
    es: "Summarize in Spanish.",
    zh: "用中文总结。",
    fr: "Résumez en français.",
    it: "Riassumi in italiano.",
    ko: "한국어로 요약해주세요。",
    ar: "لخص باللغة العربية。",
    hi: "हिंदी में संक्षेप करें।",
    ru: "Резюмируйте на русском языке।",
    id: "Ringkas dalam Bahasa Indonesia।",
  };

  const languageInstruction = languageInstructions[summaryLanguage] || "Summarize in English.";

  const prompts: Record<string, string> = {
    short: `You are a professional executive assistant specializing in creating concise presentation summaries for C-level executives.\n\nAnalyze the following transcript and provide ONLY a SHORT summary. Do NOT include any preamble, introduction, or explanation in exactly 4-5 lines. Focus on the most critical points, key decisions, and actionable outcomes. Write in a professional, executive-level tone suitable for busy decision-makers who need immediate insights. ${languageInstruction}\n\nRequirements:\n- Exactly 4-5 lines of text\n- No bullet points, lists, or markdown formatting\n- Focus on main conclusions, decisions, and next steps\n- Professional business language with executive tone\n- Capture the essence and business impact in minimal words\n- Prioritize actionable insights and strategic implications

IMPORTANT: Output ONLY the summary text. Do not include any introductory phrases like "Here is the summary" or "I will provide a summary". Do not include any closing remarks.\n\nTranscript: ${transcript}`,

    medium: `You are a professional business analyst creating presentation summaries for corporate teams and stakeholders.\n\nAnalyze the following transcript and provide ONLY a MEDIUM-length summary. Do NOT include any preamble, introduction, or explanation that balances comprehensive coverage with readability. Structure your response to cover the main topics, key arguments, important decisions, and strategic implications. ${languageInstruction}\n\nRequirements:\n- 3-4 well-structured paragraphs (150-250 words total)\n- Cover main topics, key points, and strategic context\n- Include important details, decisions, and action items\n- Professional business writing style suitable for team sharing\n- Clear logical flow from overview to specifics to conclusions\n- Suitable for middle management and project teams\n\nStructure your response as:\n1. Opening paragraph: Main topic, purpose, and key participants\n2. Core content: Key points, arguments, and discussions\n3. Outcomes: Conclusions, decisions, and recommended next steps\n\nTranscript: ${transcript}`,

    detailed: `You are a professional executive assistant specializing in creating comprehensive presentation summaries.\n\nAnalyze the following transcript and provide ONLY a DETAILED summary. Do NOT include any preamble, introduction, or explanation covering all major points. ${languageInstruction}\n\nTranscript: ${transcript}`,
  };

  return prompts[summaryType] || prompts.medium;
}

async function generateSummaryWithLLM(
  transcript: string,
  summaryType: string = "medium",
  summaryLanguage: string = "en"
): Promise<string | null> {
  try {
    const prompt = getSummaryPrompt(summaryType, transcript, summaryLanguage);

    const response = await invokeLLM({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    if (response.choices && response.choices[0]?.message?.content) {
      const content = response.choices[0].message.content;
      if (typeof content === "string") {
        return content;
      }
    }

    return null;
  } catch (error) {
    console.error(`[LLM ERROR] Failed to generate summary: ${error}`);
    return null;
  }
}

async function translateWithLLM(
  text: string,
  targetLanguage: string,
  previousTranslation?: string
): Promise<string | null> {
  try {
    const languageNames: Record<string, string> = {
      ja: "Japanese",
      es: "Spanish",
      zh: "Chinese",
      fr: "French",
      it: "Italian",
      ko: "Korean",
      ar: "Arabic",
      hi: "Hindi",
      ru: "Russian",
      id: "Indonesian",
    };

    const targetLanguageName = languageNames[targetLanguage] || "Japanese";

    let prompt: string;
    if (previousTranslation) {
      prompt = `You are translating a live speech transcription to ${targetLanguageName}. Translate the following new text segment to continue smoothly from the previous translation. Provide only the translation.\n\nNew text to translate: ${text}\n\nPrevious translation context: ${previousTranslation}`;
    } else {
      prompt = `Translate the following English text to ${targetLanguageName}. Provide only the translation.\n\nText to translate: ${text}`;
    }

    const response = await invokeLLM({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    if (response.choices && response.choices[0]?.message?.content) {
      const content = response.choices[0].message.content;
      if (typeof content === "string") {
        return content;
      }
    }

    return null;
  } catch (error) {
    console.error(`[LLM ERROR] Failed to translate text: ${error}`);
    return null;
  }
}

export function createAudioRoutes(): Router {
  const router = Router();

  // Start session
  router.post("/api/start-session", async (req: Request, res: Response) => {
    try {
      const { language = "en" } = req.body;
      const sessionId = uuidv4();
      sessionData[sessionId] = {
        transcript: "",
        deepgramCalls: 0,
        accumulatedSize: 0,
        language: language,
      };
      console.log(`[SESSION] Language set to: ${language}`);

      console.log(`[SESSION] Started: ${sessionId}`);

      res.json({
        success: true,
        session_id: sessionId,
        message: "Session started successfully",
      });
    } catch (error) {
      console.error(`[SESSION ERROR] ${error}`);
      res.status(500).json({
        success: false,
        error: String(error),
      });
    }
  });

  // Upload chunk
  router.post("/api/upload-chunk", async (req: Request, res: Response) => {
    try {
      const sessionId = req.body.session_id || req.query.session_id;
      const chunkNumber = req.body.chunk_number || req.query.chunk_number || "0";

      if (!sessionId || !sessionData[sessionId]) {
        return res.status(400).json({
          success: false,
          error: "Invalid session ID",
        });
      }

      const audioFile = (req as any).file;
      if (!audioFile || !audioFile.buffer) {
        return res.status(400).json({
          success: false,
          error: "No audio file provided",
        });
      }

      const audioData: Buffer = audioFile.buffer;
      console.log(`[CHUNK] Session ${sessionId}, Chunk ${chunkNumber}: ${audioData.length} bytes`);

      // Transcribe with Deepgram
      const language = sessionData[sessionId].language || "en";
      const transcription = await transcribeWithDeepgram(audioData, language);

      if (transcription) {
        const currentTranscript = sessionData[sessionId].transcript;
        const updatedTranscript = currentTranscript
          ? `${currentTranscript} ${transcription}`
          : transcription;

        sessionData[sessionId].transcript = updatedTranscript;
        sessionData[sessionId].deepgramCalls += 1;
        sessionData[sessionId].accumulatedSize += audioData.length;

        console.log(`[DEEPGRAM] Call #${sessionData[sessionId].deepgramCalls}: ${transcription.length} chars`);

        return res.json({
          success: true,
          chunk_number: chunkNumber,
          transcription,
          complete_text: updatedTranscript,
          deepgram_calls: sessionData[sessionId].deepgramCalls,
          accumulated_size: sessionData[sessionId].accumulatedSize,
        });
      }

      return res.json({
        success: true,
        chunk_number: chunkNumber,
        transcription: "",
        complete_text: sessionData[sessionId].transcript,
        deepgram_calls: sessionData[sessionId].deepgramCalls,
        accumulated_size: sessionData[sessionId].accumulatedSize,
      });
    } catch (error) {
      console.error(`[CHUNK ERROR] ${error}`);
      res.status(500).json({
        success: false,
        error: String(error),
      });
    }
  });

  // Stop session
  router.post("/api/stop-session", async (req: Request, res: Response) => {
    try {
      const sessionId = req.body.session_id;

      if (!sessionId || !sessionData[sessionId]) {
        return res.status(400).json({
          success: false,
          error: "Invalid session ID",
        });
      }

      const session = sessionData[sessionId];
      console.log(`[SESSION] Stopped: ${sessionId}`);

      res.json({
        success: true,
        complete_text: session.transcript,
        total_chunks: 0,
        deepgram_calls: session.deepgramCalls,
        total_size: session.accumulatedSize,
      });
    } catch (error) {
      console.error(`[STOP ERROR] ${error}`);
      res.status(500).json({
        success: false,
        error: String(error),
      });
    }
  });

  // Generate summary
  router.post("/api/generate-summary", async (req: Request, res: Response) => {
    try {
      const sessionId = req.body.session_id;
      const summaryType = req.body.summary_type || "medium";
      const summaryLanguage = req.body.summary_language || "en";

      if (!sessionId || !sessionData[sessionId]) {
        return res.status(400).json({
          success: false,
          error: "Invalid session ID",
        });
      }

      const transcript = sessionData[sessionId].transcript;

      if (!transcript || transcript.trim().length < 50) {
        return res.status(400).json({
          success: false,
          error: "Transcript too short for summary generation",
        });
      }

      console.log(`[SUMMARY] Generating ${summaryType} summary for session ${sessionId}`);

      const summary = await generateSummaryWithLLM(transcript, summaryType, summaryLanguage);

      if (!summary) {
        return res.status(500).json({
          success: false,
          error: "Failed to generate summary",
        });
      }

      console.log(`[SUMMARY SUCCESS] Generated ${summaryType} summary: ${summary.length} chars`);

      res.json({
        success: true,
        summary,
        summary_type: summaryType,
        original_text: transcript,
      });
    } catch (error) {
      console.error(`[SUMMARY ERROR] ${error}`);
      res.status(500).json({
        success: false,
        error: String(error),
      });
    }
  });

  // Translate
  router.post("/api/translate", async (req: Request, res: Response) => {
    try {
      const text = req.body.text || "";
      const targetLanguage = req.body.target_language || "ja";
      const previousTranslation = req.body.previous_translation || "";

      if (!text || !targetLanguage) {
        return res.status(400).json({
          success: false,
          error: "Missing text or target_language",
        });
      }

      console.log(`[TRANSLATION] Translating to ${targetLanguage}: ${text.substring(0, 100)}...`);

      const translation = await translateWithLLM(text, targetLanguage, previousTranslation || undefined);

      if (!translation) {
        return res.status(500).json({
          success: false,
          error: "Failed to translate text",
        });
      }

      console.log(`[TRANSLATION] Successfully translated: ${translation.substring(0, 100)}...`);

      res.json({
        success: true,
        translation,
      });
    } catch (error) {
      console.error(`[TRANSLATION ERROR] ${error}`);
      res.status(500).json({
        success: false,
        error: String(error),
      });
    }
  });

  return router;
}

