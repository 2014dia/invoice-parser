import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "invoice-parser-endpoint" });
});

function detectFileType(buffer) {
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return { kind: "pdf", mime: "application/pdf", ext: "pdf" };
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  }

  return { kind: "unknown", mime: "application/octet-stream", ext: "bin" };
}

async function processFile(fileUrl) {
  const fileResponse = await fetch(fileUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    }
  });

  if (!fileResponse.ok) {
    throw new Error(`Failed to download file: ${fileResponse.status}`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());

  if (buffer.length < 500) {
    throw new Error("File too small — invalid");
  }

  return buffer;
}

/* ===========================
   RICHELIEU PARSER (EXISTING)
   =========================== */
app.post("/parse-invoice", async (req, res) => {
  try {
    const vendor = String(req.body.vendor || "").trim();
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    const fileBuffer = await processFile(fileUrl);
    const detected = detectFileType(fileBuffer);

    let content = [
      {
        type: "input_text",
        text: `Extract invoice data... (your existing prompt unchanged)`
      }
    ];

    if (detected.kind === "pdf") {
      const file = await client.files.create({
        file: await toFile(fileBuffer, "invoice.pdf"),
        purpose: "user_data"
      });

      content.push({ type: "input_file", file_id: file.id });
    }

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse invoice" });
  }
});

/* ===========================
   LIOHER PARSER (NEW)
   =========================== */
app.post("/parse-invoice-lioher", async (req, res) => {
  try {
    const fileUrl = String(req.body.file_url || req.body.file || "").trim();

    const fileBuffer = await processFile(fileUrl);

    const file = await client.files.create({
      file: await toFile(fileBuffer, "lioher.pdf"),
      purpose: "user_data"
    });

    const response = await client.responses.create({
      model: process.env.MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Extract invoice data from this Lioher invoice.

Return ONLY JSON.

Fields:
- invoice_number
- invoice_date
- due_date
- reference
- total_amount
- vendor = "Lioher"
- items[]

ITEM RULES:

Category:
- PANEL → category = panel
- EDGE → category = edge
- LAMINATE → category = laminate

Subcategory:
- panel syncron / edge syncron
- panel zenit / edge zenit
- panel luxe / edge luxe
- laminate

Quantity:
- PANEL → take ONLY number before EA
- LAMINATE → same as panel (EA only)
- EDGE → take ONLY number before FT

Examples:
"2 EA 108.339 FT2" → 2
"738.000 FT" → 738

Ignore:
- FT2 values for panel/laminate
- decimals like .000

Return clean JSON only.`
            },
            {
              type: "input_file",
              file_id: file.id
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = JSON.parse(response.output_text);
    res.json(parsed);

  } catch (err) {
    console.error("lioher error:", err);
    res.status(500).json({ error: "Failed to parse Lioher invoice" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});