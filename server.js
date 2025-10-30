// server.js
// Простой proxy для запросов к OpenAI с ограничением по теме и лимитом по IP (in-memory).
// Для продакшена используйте persistent storage для лимитов.

import express from "express";
import fetch from "node-fetch"; // или native fetch в Node 18+
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json());

// Простое rate-limit по IP: 60 запросов в час (дополнительно ниже реализован лимит "переводов" в сессии)
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: "Too many requests, try later." },
});
app.use(limiter);

// В памяти храним счётчик запросов "учителю" для каждого IP (сброс при рестарте)
const ipAttempts = {}; // { ip: count }

const MAX_ATTEMPTS_PER_IP = 30; // можно снизить до 10, по желанию

// Системная инструкция — жёстко ограничивает поведение ИИ
const SYSTEM_PROMPT = `
You are a helpful English teacher named "Tutor" who only answers questions about the topic "Mass Media".
Answer briefly and simply in English. DO NOT solve assigned exercises or provide answers to tests. DO NOT provide translations of student's texts. If the question is outside "Mass Media", politely say you can only answer questions about "Mass Media". Keep answers concise (one short paragraph).
`;

// Endpoint: POST /api/chat { "question": "..." }
app.post("/api/chat", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    ipAttempts[ip] = ipAttempts[ip] || 0;
    if (ipAttempts[ip] >= MAX_ATTEMPTS_PER_IP) {
      return res.status(429).json({ error: "Limit of questions reached for this session." });
    }

    const { question } = req.body;
    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({ error: "Empty question" });
    }

    // Простейшая защита: запрет слов "answer key", "решени", "translate", "перевод"
    const forbiddenPatterns = [/answer\s*key/i, /решен/i, /translate/i, /перевod/i, /реш(ени|ать)/i];
    for (const p of forbiddenPatterns) {
      if (p.test(question)) {
        return res.status(400).json({ error: "Questions asking for solutions/translations are not allowed." });
      }
    }

    // ограничение длины вопроса (например 120 слов)
    const words = question.trim().split(/\s+/).length;
    if (words > 120) {
      return res.status(400).json({ error: "Question too long (max 120 words)." });
    }

    // Собираем сообщения для OpenAI — системное + пользовательский вопрос
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: question }
    ];

    // Вызов OpenAI Chat Completions (замени URL/параметры при необходимости)
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      return res.status(500).json({ error: "Server misconfigured: missing OPENAI_API_KEY" });
    }

    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // при желании поменяй на доступную модель
        messages,
        temperature: 0.2,
        max_tokens: 160 // краткие ответы
      })
    });

    const data = await openaiResp.json();

    // безопасная обработка ошибок OpenAI
    if (!openaiResp.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({ error: "AI service error" });
    }

    const assistantText = data.choices?.[0]?.message?.content?.trim();
    if (!assistantText) {
      return res.status(500).json({ error: "No answer from AI" });
    }

    // Увеличиваем счётчик IP (успешный вопрос)
    ipAttempts[ip]++;

    // Возвращаем ответ
    res.json({ answer: assistantText, remaining: MAX_ATTEMPTS_PER_IP - ipAttempts[ip] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Лёгкий health-check
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
