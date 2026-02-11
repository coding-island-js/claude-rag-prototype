import "dotenv/config";
import express from "express";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import { readFile, unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// File upload configuration
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(txt|md)$/)) {
      cb(null, true);
    } else {
      cb(new Error("Only .txt and .md files allowed"));
    }
  },
});

// In-memory document store
let documents = [];

// Budget tracking (safety guard)
let totalSpent = 0;
const BUDGET_LIMIT = 1.0; // $1 safety limit

// Helper: Calculate cost from usage
function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1_000_000) * 3.0;
  const outputCost = (usage.output_tokens / 1_000_000) * 15.0;
  const cacheWriteCost =
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * 3.75;
  const cacheReadCost =
    ((usage.cache_read_input_tokens || 0) / 1_000_000) * 0.3;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

// Upload endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const content = await readFile(req.file.path, "utf-8");

    const doc = {
      id: documents.length,
      filename: req.file.originalname,
      path: req.file.path,
      content: content,
      uploadedAt: new Date(),
      size: content.length,
    };

    documents.push(doc);

    res.json({
      success: true,
      document: {
        id: doc.id,
        filename: doc.filename,
        size: doc.size,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List documents endpoint
app.get("/documents", (req, res) => {
  res.json({
    documents: documents.map((d) => ({
      id: d.id,
      filename: d.filename,
      size: d.size,
      uploadedAt: d.uploadedAt,
    })),
  });
});

// Query endpoint - LOAD ALL MODE (demonstrates the problem)
app.post("/query-all", async (req, res) => {
  try {
    const { question } = req.body;

    if (totalSpent >= BUDGET_LIMIT) {
      return res
        .status(429)
        .json({ error: `Budget limit reached: $${totalSpent.toFixed(2)}` });
    }

    // Build context with ALL documents (no caching, no selection)
    let systemPrompt =
      "You are a helpful assistant. Answer questions based on the provided documents. Cite which document you used.\n\n";

    documents.forEach((doc) => {
      systemPrompt += `DOCUMENT: ${doc.filename}\n\n${doc.content}\n\n---\n\n`;
    });

    const startTime = Date.now();

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    const responseTime = Date.now() - startTime;
    const cost = calculateCost(response.usage);
    totalSpent += cost;

    res.json({
      answer: response.content[0].text,
      mode: "load_all",
      docsLoaded: documents.length,
      usage: response.usage,
      cost: cost,
      totalSpent: totalSpent,
      responseTime,
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Query endpoint - SMART MODE (demonstrates the solution)
app.post("/query-smart", async (req, res) => {
  try {
    const { question } = req.body;

    if (totalSpent >= BUDGET_LIMIT) {
      return res
        .status(429)
        .json({ error: `Budget limit reached: $${totalSpent.toFixed(2)}` });
    }

    // Step 1: Build document index
    const documentIndex = documents
      .map(
        (d) =>
          `ID: ${d.id}\nFilename: ${d.filename}\nSize: ${d.size} characters`,
      )
      .join("\n\n");

    // Step 2: Ask Claude which documents are relevant
    const selectionResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      system: `You are a document retrieval system. Given a user question and a list of available documents, return ONLY a JSON array of document IDs that are relevant.

Available documents:
${documentIndex}

Return format: {"relevant_docs": [0, 2, 5]}
Return an empty array if no documents are relevant.
Be selective - only choose documents directly relevant to answering the question.`,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nWhich document IDs are relevant? Return only JSON.`,
        },
      ],
    });

    // Parse Claude's selection
    const selectionText = selectionResponse.content[0].text;
    let relevantDocIds = [];

    try {
      const parsed = JSON.parse(
        selectionText.replace(/```json|```/g, "").trim(),
      );
      relevantDocIds = parsed.relevant_docs || [];
    } catch (e) {
      // Fallback: extract numbers
      const matches = selectionText.match(/\d+/g);
      relevantDocIds = matches ? matches.map(Number) : [];
    }

    console.log("Smart mode selected docs:", relevantDocIds);

    // Step 3: Build cached context with only relevant documents
    const systemBlocks = [
      {
        type: "text",
        text: "You are a helpful assistant. Answer questions based ONLY on the provided documents. Cite which document you used.",
        cache_control: { type: "ephemeral" },
      },
    ];

    // Add each relevant document as a cached block
    relevantDocIds.forEach((id) => {
      const doc = documents[id];
      if (doc) {
        systemBlocks.push({
          type: "text",
          text: `DOCUMENT: ${doc.filename}\n\n${doc.content}`,
          cache_control: { type: "ephemeral" },
        });
      }
    });

    const startTime = Date.now();

    // Step 4: Get final answer with caching
    const answerResponse = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: question,
        },
      ],
    });

    const responseTime = Date.now() - startTime;

    // Calculate total cost (selection + answer)
    const selectionCost = calculateCost(selectionResponse.usage);
    const answerCost = calculateCost(answerResponse.usage);
    const totalCost = selectionCost + answerCost;
    totalSpent += totalCost;

    res.json({
      answer: answerResponse.content[0].text,
      mode: "smart",
      docsLoaded: relevantDocIds.length,
      selectedDocs: relevantDocIds.map((id) => ({
        id,
        filename: documents[id]?.filename,
      })),
      usage: answerResponse.usage,
      cost: totalCost,
      totalSpent: totalSpent,
      responseTime,
      cacheStats: {
        cacheCreationTokens:
          answerResponse.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: answerResponse.usage.cache_read_input_tokens || 0,
      },
    });
  } catch (error) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get budget status
app.get("/budget", (req, res) => {
  res.json({
    spent: totalSpent,
    limit: BUDGET_LIMIT,
    remaining: BUDGET_LIMIT - totalSpent,
  });
});

// Reset (for testing)
app.post("/reset", async (req, res) => {
  try {
    // Delete uploaded files
    for (const doc of documents) {
      if (doc && doc.path) {
        try {
          await unlink(doc.path);
        } catch (e) {
          // File might already be deleted
        }
      }
    }

    documents = [];
    totalSpent = 0;

    res.json({ success: true, message: "System reset" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 Server running on http://localhost:${PORT}

Budget: $${BUDGET_LIMIT}
Spent: $${totalSpent.toFixed(4)}
  `);
});
